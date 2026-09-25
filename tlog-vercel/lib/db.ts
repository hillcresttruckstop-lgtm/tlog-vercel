/**
 * db.ts
 * ======
 * Neon Postgres storage for parsed TLog transactions, using the
 * @neondatabase/serverless HTTP driver (the right choice for Vercel
 * serverless functions - no persistent TCP connection pool to manage).
 *
 * Schema mirrors the SQLite version that was tested locally, translated
 * to Postgres types (TIMESTAMPTZ, BIGSERIAL, etc).
 */

import { neon } from "@neondatabase/serverless";
import type { Transaction, VoidTicket } from "./tlogParser";
import crypto from "crypto";

function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (add it in Vercel project settings).");
  return neon(url);
}

export async function initSchema() {
  const db = sql();
  await db`
    CREATE TABLE IF NOT EXISTS transactions (
      unique_id       TEXT PRIMARY KEY,
      source_file     TEXT,
      trans_type      TEXT,
      pos_num         INTEGER,
      tr_seq          TEXT,
      date            TIMESTAMPTZ NOT NULL,
      cashier         TEXT,
      till            INTEGER,
      total_no_tax    NUMERIC,
      total_with_tax  NUMERIC,
      total_tax       NUMERIC,
      ingested_at     TIMESTAMPTZ DEFAULT now()
    )
  `;
  await db`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tr_seq TEXT`;
  await db`CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)`;

  await db`
    CREATE TABLE IF NOT EXISTS transaction_lines (
      id              BIGSERIAL PRIMARY KEY,
      unique_id       TEXT NOT NULL REFERENCES transactions(unique_id),
      dept_number     TEXT,
      dept_type       TEXT,
      category        TEXT,
      description     TEXT,
      qty             NUMERIC,
      unit_price      NUMERIC,
      line_total      NUMERIC,
      is_fuel         BOOLEAN,
      fuel_grade      TEXT,
      fuel_volume     NUMERIC,
      pump_number     INTEGER,
      is_void_line    BOOLEAN DEFAULT false
    )
  `;
  // Safe to run even if the table already existed before this column was added.
  await db`ALTER TABLE transaction_lines ADD COLUMN IF NOT EXISTS category TEXT`;
  await db`ALTER TABLE transaction_lines ADD COLUMN IF NOT EXISTS is_void_line BOOLEAN DEFAULT false`;
  await db`CREATE INDEX IF NOT EXISTS idx_lines_unique_id ON transaction_lines(unique_id)`;
  await db`CREATE INDEX IF NOT EXISTS idx_lines_is_fuel ON transaction_lines(is_fuel)`;
  await db`CREATE INDEX IF NOT EXISTS idx_lines_category ON transaction_lines(category)`;
  // Matches the single most common query shape in this file: join
  // transaction_lines to transactions via unique_id, then filter by
  // is_fuel - used by getKpis, getFuelByGrade, getMerchByCategory,
  // getMerchByDepartment, getPumpActivity, getDailyLedger, and
  // getPumpHealthFlags. The plain single-column is_fuel index above is
  // low-selectivity on its own (only two possible values, so Postgres
  // often skips it in favor of a sequential scan) - this composite index
  // is what actually helps the join+filter combination those queries share.
  await db`CREATE INDEX IF NOT EXISTS idx_lines_uniqueid_isfuel ON transaction_lines(unique_id, is_fuel)`;
  // Void lines are a tiny fraction of all rows (a cashier voiding one item
  // mid-sale is rare) - a PARTIAL index (only indexing the true rows) is
  // far smaller and faster to maintain than a full index would be, for
  // exactly the query the Void Lines panel runs.
  await db`CREATE INDEX IF NOT EXISTS idx_lines_void_line ON transaction_lines(is_void_line) WHERE is_void_line = true`;

  await db`
    CREATE TABLE IF NOT EXISTS transaction_payments (
      id              BIGSERIAL PRIMARY KEY,
      unique_id       TEXT NOT NULL REFERENCES transactions(unique_id),
      tender_type     TEXT,
      amount          NUMERIC,
      card_last4      TEXT
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_payments_unique_id ON transaction_payments(unique_id)`;
  // Repeat Customers groups by card_last4 over potentially a full year of
  // payments - without this, that query has to scan every payment row
  // rather than seeking directly to matching cards as the table grows.
  await db`CREATE INDEX IF NOT EXISTS idx_payments_card_last4 ON transaction_payments(card_last4) WHERE card_last4 IS NOT NULL`;

  await db`
    CREATE TABLE IF NOT EXISTS processed_files (
      filename        TEXT PRIMARY KEY,
      file_hash       TEXT,
      processed_at    TIMESTAMPTZ DEFAULT now(),
      txn_count       INTEGER,
      modified_time   TEXT
    )
  `;
  // Safe to run even if the table already existed before this column was added.
  await db`ALTER TABLE processed_files ADD COLUMN IF NOT EXISTS modified_time TEXT`;

  // A void ticket carries full detail (register, cashier, total, line
  // items) - lines are stored as JSON rather than a separate child table
  // since void volume is very low (a handful per day at most), so the
  // extra join overhead of a real child table buys nothing here. This is
  // deliberately its own table, not folded into `transactions` - a void
  // carries no real sale, so keeping it fully separate means no existing
  // revenue/transaction-count query needs to remember to filter it back
  // out (the same class of mistake that caused the fuel-deposit
  // double-counting bug already fixed once in the parser).
  await db`
    CREATE TABLE IF NOT EXISTS void_transactions (
      unique_id       TEXT PRIMARY KEY,
      tr_seq          TEXT,
      pos_num         INTEGER,
      date            TIMESTAMPTZ NOT NULL,
      cashier         TEXT,
      total_with_tax  NUMERIC,
      lines           JSONB,
      source_file     TEXT
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_void_transactions_date ON void_transactions(date)`;
}

export function fileHash(raw: Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Cheap pre-check using Google Drive's own modifiedTime metadata - lets
 * the caller skip downloading a file ENTIRELY if Drive says it hasn't
 * changed since we last processed it. This is the difference between
 * downloading every historical archive file on every single run forever,
 * versus only ever downloading each one once. */
export async function getKnownModifiedTime(filename: string): Promise<string | null> {
  const db = sql();
  const rows = await db`SELECT modified_time FROM processed_files WHERE filename = ${filename}`;
  return rows.length > 0 ? (rows[0].modified_time as string | null) : null;
}

/** Same lookup as getKnownModifiedTime, but for every file in one query
 * instead of one query per file. FIXED: the ingest run used to call
 * getKnownModifiedTime in a loop, once per file in the Drive folder - for
 * 343+ files (and growing every day), that's 343+ sequential database
 * queries on EVERY single ingest cycle, every 15 minutes, before any
 * actual work even starts. That directly eats into the 30-second
 * cron-job.org budget this same ingest run has to fit inside. Returns a
 * Map so the caller can do the comparison in memory. */
export async function getKnownModifiedTimes(filenames: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (filenames.length === 0) return map;
  const db = sql();
  const rows = await db.query(
    `SELECT filename, modified_time FROM processed_files WHERE filename = ANY($1::text[])`,
    [filenames]
  );
  for (const r of rows as any[]) map.set(r.filename, r.modified_time);
  return map;
}

export async function isFileUnchanged(filename: string, hash: string): Promise<boolean> {
  const db = sql();
  const rows = await db`SELECT file_hash FROM processed_files WHERE filename = ${filename}`;
  return rows.length > 0 && rows[0].file_hash === hash;
}

export async function markFileProcessed(
  filename: string,
  hash: string,
  txnCount: number,
  modifiedTime: string | null = null
) {
  const db = sql();
  await db`
    INSERT INTO processed_files (filename, file_hash, processed_at, txn_count, modified_time)
    VALUES (${filename}, ${hash}, now(), ${txnCount}, ${modifiedTime})
    ON CONFLICT (filename) DO UPDATE SET
      file_hash = excluded.file_hash,
      processed_at = now(),
      txn_count = excluded.txn_count,
      modified_time = excluded.modified_time
  `;
}

export async function ingestVoidTickets(voidTickets: VoidTicket[]): Promise<number> {
  if (voidTickets.length === 0) return 0;
  const db = sql();
  const rows = await db.query(
    `INSERT INTO void_transactions (unique_id, tr_seq, pos_num, date, cashier, total_with_tax, lines, source_file)
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::timestamptz[], $5::text[], $6::numeric[], $7::jsonb[], $8::text[])
     ON CONFLICT (unique_id) DO NOTHING
     RETURNING unique_id`,
    [
      voidTickets.map((v) => v.unique_id),
      voidTickets.map((v) => v.tr_seq),
      voidTickets.map((v) => v.pos_num),
      voidTickets.map((v) => v.date),
      voidTickets.map((v) => v.cashier),
      voidTickets.map((v) => v.total_with_tax),
      voidTickets.map((v) => JSON.stringify(v.lines)),
      voidTickets.map((v) => v.source_file),
    ]
  );
  return (rows as any[]).length;
}

export async function getVoidCount(start: string, end: string): Promise<number> {
  const db = sql();
  const [row] = await db`
    SELECT COUNT(*)::int AS c FROM void_transactions WHERE date >= ${start} AND date < ${end}
  `;
  return row.c as number;
}

/** List of void tickets for a range - enough detail for a summary row
 * (time, register, total); the full line-item detail already sits in the
 * `lines` JSON column and comes along for free, so a click-through needs
 * no second query. */
export async function getVoidTickets(start: string, end: string, limit = 100) {
  const db = sql();
  const rows = await db`
    SELECT unique_id, tr_seq, pos_num, date, cashier, total_with_tax, lines
    FROM void_transactions WHERE date >= ${start} AND date < ${end}
    ORDER BY date DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, total_with_tax: Number(r.total_with_tax) }));
}

/** Individual voided LINE ITEMS from inside otherwise-normal, completed
 * sales (VeriFone tags the line itself "void plu" - a cashier voiding one
 * item mid-sale, distinct from an entire ticket being void). Confirmed
 * real: the voided line carries a negative line_total that already nets
 * correctly against the original positive line, so this is purely a
 * transparency view - it changes no totals anywhere else. */
export async function getVoidLines(start: string, end: string, limit = 100) {
  const db = sql();
  const rows = await db`
    SELECT l.description, l.category, l.line_total, t.unique_id, t.tr_seq, t.date, t.cashier
    FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_void_line = true AND t.date >= ${start} AND t.date < ${end}
    ORDER BY t.date DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, line_total: r.line_total === null ? null : Number(r.line_total) }));
}

export async function ingestTransactions(transactions: Transaction[]): Promise<number> {
  if (transactions.length === 0) return 0;
  const db = sql();

  // Step 1: find which of these unique_ids we already have, in ONE query,
  // instead of relying on a per-row INSERT...ON CONFLICT round-trip each.
  const allIds = transactions.map((t) => t.unique_id);
  const existing = await db.query(
    `SELECT unique_id FROM transactions WHERE unique_id = ANY($1::text[])`,
    [allIds]
  );
  const existingSet = new Set((existing as any[]).map((r) => r.unique_id));
  const newTxns = transactions.filter((t) => !existingSet.has(t.unique_id));
  if (newTxns.length === 0) return 0;

  // Step 2: bulk-insert all candidate transactions in ONE query via
  // unnest(), and RETURNING the unique_ids that were ACTUALLY inserted.
  //
  // This RETURNING is what makes concurrent ingestion safe. current.1 and
  // current.2 (Shift vs Day period exports) contain the exact same
  // transactions - confirmed against real data (100% unique_id overlap).
  // Both files get processed with several others running concurrently for
  // speed. If both calls to this function separately checked "does this
  // exist yet" (the query above) before EITHER had committed its insert,
  // both would conclude the same batch is "new" and both would proceed to
  // Steps 3/4 - and since transaction_lines/transaction_payments have no
  // uniqueness constraint of their own, that silently inserted every line
  // item TWICE, which is exactly what was inflating fuel gallons/revenue
  // to roughly 2x the real figures (confirmed against real production
  // data: 6,846.6 gal shown vs 3,559.060 actual, a ~1.92x ratio).
  // ON CONFLICT DO NOTHING + RETURNING is what actually closes this: for
  // any unique_id two concurrent inserts both attempt, Postgres guarantees
  // only ONE of them gets it back in RETURNING - so only that one caller's
  // Steps 3/4 below will ever insert its lines/payments, no matter how the
  // two calls happen to interleave in real time.
  const insertedRows = await db.query(
    `INSERT INTO transactions
       (unique_id, source_file, trans_type, pos_num, tr_seq, date, cashier, till,
        total_no_tax, total_with_tax, total_tax)
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::timestamptz[],
       $7::text[], $8::int[], $9::numeric[], $10::numeric[], $11::numeric[]
     )
     ON CONFLICT (unique_id) DO NOTHING
     RETURNING unique_id`,
    [
      newTxns.map((t) => t.unique_id),
      newTxns.map((t) => t.source_file),
      newTxns.map((t) => t.trans_type),
      newTxns.map((t) => t.pos_num),
      newTxns.map((t) => t.tr_seq),
      newTxns.map((t) => t.date),
      newTxns.map((t) => t.cashier),
      newTxns.map((t) => t.till),
      newTxns.map((t) => t.total_no_tax),
      newTxns.map((t) => t.total_with_tax),
      newTxns.map((t) => t.total_tax),
    ]
  );
  const actuallyInsertedIds = new Set((insertedRows as any[]).map((r) => r.unique_id));
  // Only these ACTUALLY got a transactions row from this call - restrict
  // everything below to exactly this set, not the full newTxns candidate
  // list computed before the insert.
  const confirmedNewTxns = newTxns.filter((t) => actuallyInsertedIds.has(t.unique_id));
  if (confirmedNewTxns.length === 0) return 0;

  // Step 3: flatten every line item across confirmed-new transactions
  // into parallel arrays, and bulk-insert them in ONE query.
  const lineOwners: string[] = [];
  const lineDeptNum: (string | null)[] = [];
  const lineDeptType: (string | null)[] = [];
  const lineCategory: (string | null)[] = [];
  const lineDesc: (string | null)[] = [];
  const lineQty: (number | null)[] = [];
  const lineUnitPrice: (number | null)[] = [];
  const lineTotal: (number | null)[] = [];
  const lineIsFuel: boolean[] = [];
  const lineFuelGrade: (string | null)[] = [];
  const lineFuelVolume: (number | null)[] = [];
  const linePumpNumber: (number | null)[] = [];
  const lineIsVoid: boolean[] = [];

  for (const txn of confirmedNewTxns) {
    for (const line of txn.lines) {
      lineOwners.push(txn.unique_id);
      lineDeptNum.push(line.dept_number);
      lineDeptType.push(line.dept_type);
      lineCategory.push(line.category);
      lineDesc.push(line.description);
      lineQty.push(line.qty);
      lineUnitPrice.push(line.unit_price);
      lineTotal.push(line.line_total);
      lineIsFuel.push(line.is_fuel);
      lineFuelGrade.push(line.fuel_grade);
      lineFuelVolume.push(line.fuel_volume);
      linePumpNumber.push(line.pump_number);
      lineIsVoid.push(line.is_void_line);
    }
  }
  if (lineOwners.length > 0) {
    await db.query(
      `INSERT INTO transaction_lines
         (unique_id, dept_number, dept_type, category, description, qty, unit_price,
          line_total, is_fuel, fuel_grade, fuel_volume, pump_number, is_void_line)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[],
         $7::numeric[], $8::numeric[], $9::boolean[], $10::text[], $11::numeric[], $12::int[], $13::boolean[]
       )`,
      [
        lineOwners, lineDeptNum, lineDeptType, lineCategory, lineDesc, lineQty,
        lineUnitPrice, lineTotal, lineIsFuel, lineFuelGrade, lineFuelVolume, linePumpNumber, lineIsVoid,
      ]
    );
  }

  // Step 4: same bulk approach for payments.
  const payOwners: string[] = [];
  const payTender: string[] = [];
  const payAmount: (number | null)[] = [];
  const payCard: (string | null)[] = [];
  for (const txn of confirmedNewTxns) {
    for (const pay of txn.payments) {
      payOwners.push(txn.unique_id);
      payTender.push(pay.tender_type);
      payAmount.push(pay.amount);
      payCard.push(pay.card_last4);
    }
  }
  if (payOwners.length > 0) {
    await db.query(
      `INSERT INTO transaction_payments (unique_id, tender_type, amount, card_last4)
       SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::text[])`,
      [payOwners, payTender, payAmount, payCard]
    );
  }

  return newTxns.length;
}

// ── Dashboard queries ──────────────────────────────────────

/** Full detail for exactly one transaction, by unique_id - used when
 * clicking through from a Void Line to the full transaction it belongs
 * to (the same detail view a normal feed row or void ticket opens). */
export async function getTransactionById(uniqueId: string) {
  const db = sql();
  const rows = await db`
    SELECT unique_id, trans_type, pos_num, tr_seq, date, cashier, total_with_tax
    FROM transactions WHERE unique_id = ${uniqueId}
  `;
  if (rows.length === 0) return null;
  const r = rows[0];

  const lines = await db`
    SELECT description, category, dept_number, qty, unit_price, is_fuel, fuel_grade, fuel_volume, pump_number, line_total, is_void_line
    FROM transaction_lines WHERE unique_id = ${uniqueId}
  `;
  const payments = await db`
    SELECT tender_type, amount FROM transaction_payments WHERE unique_id = ${uniqueId}
  `;

  return {
    ...r,
    total_with_tax: Number(r.total_with_tax),
    lines: lines.map((l) => ({
      ...l,
      qty: l.qty === null ? null : Number(l.qty),
      unit_price: l.unit_price === null ? null : Number(l.unit_price),
      fuel_volume: l.fuel_volume === null ? null : Number(l.fuel_volume),
      line_total: l.line_total === null ? null : Number(l.line_total),
    })),
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
  };
}

export async function getLiveFeed(limit = 50) {
  const db = sql();

  // FIXED: this used to fire 2 separate queries PER ROW in a loop (lines,
  // then payments) - for a 50-60 row feed, that's up to ~121 sequential
  // round trips to the database for one page load, one after another, not
  // even in parallel. Since @neondatabase/serverless's HTTP driver makes
  // each query its own network request (no persistent connection to
  // pipeline over), that latency compounds directly into how slow the
  // dashboard feels on every single refresh cycle - almost certainly the
  // dominant cause of the whole dashboard feeling sluggish. Fixed by
  // fetching all lines and all payments for the whole page of transactions
  // in exactly 2 batch queries (WHERE unique_id = ANY(...)), then grouping
  // them back onto their parent transaction in memory - 3 queries total,
  // regardless of how many transactions are in the page.
  const rows = await db`
    SELECT unique_id, trans_type, pos_num, tr_seq, date, cashier, total_with_tax
    FROM transactions ORDER BY date DESC LIMIT ${limit}
  `;
  const ids = rows.map((r) => r.unique_id as string);

  if (ids.length === 0) return [];

  const [allLines, allPayments] = await Promise.all([
    db.query(
      `SELECT unique_id, description, category, dept_number, qty, unit_price, is_fuel, fuel_grade, fuel_volume, pump_number, line_total
       FROM transaction_lines WHERE unique_id = ANY($1::text[])`,
      [ids]
    ),
    db.query(
      `SELECT unique_id, tender_type, amount FROM transaction_payments WHERE unique_id = ANY($1::text[])`,
      [ids]
    ),
  ]);

  const linesByTxn = new Map<string, any[]>();
  for (const l of allLines as any[]) {
    const arr = linesByTxn.get(l.unique_id) ?? [];
    arr.push({
      ...l,
      qty: l.qty === null ? null : Number(l.qty),
      unit_price: l.unit_price === null ? null : Number(l.unit_price),
      fuel_volume: l.fuel_volume === null ? null : Number(l.fuel_volume),
      line_total: l.line_total === null ? null : Number(l.line_total),
    });
    linesByTxn.set(l.unique_id, arr);
  }

  const paymentsByTxn = new Map<string, any[]>();
  for (const p of allPayments as any[]) {
    const arr = paymentsByTxn.get(p.unique_id) ?? [];
    arr.push({ tender_type: p.tender_type, amount: Number(p.amount) });
    paymentsByTxn.set(p.unique_id, arr);
  }

  return rows.map((r) => ({
    ...r,
    total_with_tax: Number(r.total_with_tax),
    lines: linesByTxn.get(r.unique_id as string) ?? [],
    payments: paymentsByTxn.get(r.unique_id as string) ?? [],
  }));
}

export async function getKpis(start: string, end: string) {
  const db = sql();
  const [row] = await db`
    SELECT COUNT(*)::int AS txn_count, COALESCE(SUM(total_with_tax), 0) AS revenue,
           COALESCE(SUM(total_tax), 0) AS tax_collected
    FROM transactions WHERE date >= ${start} AND date < ${end}
  `;
  const [fuelRow] = await db`
    SELECT COALESCE(SUM(l.line_total), 0) AS fuel_revenue,
           COALESCE(SUM(l.fuel_volume), 0) AS fuel_gallons
    FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_fuel = true AND t.date >= ${start} AND t.date < ${end}
  `;
  const fuelGallons = Number(fuelRow.fuel_gallons);
  const fuelRevenue = Number(fuelRow.fuel_revenue);
  const taxCollected = Number(row.tax_collected);
  // FIXED: this was "revenue - fuel_revenue" with no tax subtracted -
  // since `revenue` is total_with_tax (correctly includes tax, matching
  // "Total Business" in the daily report) but fuel_revenue does NOT
  // include tax (fuel lines' trlLineTot is pre-tax, tax is tracked only
  // at the whole-transaction level), the old formula was actually
  // computing merch+tax combined, not merch alone. Confirmed directly
  // against a real daily report: Total Business - Fuel = $3,021.71, but
  // the report's own authoritative Merch Sales is $2,879.14 - the
  // $142.57 gap is exactly that day's Tax Collected. The report's own
  // formula is explicitly "Total Business - Fuel - Tax", not just
  // "- Fuel" - matching that exactly here.
  const merchRevenue = Number(row.revenue) - fuelRevenue - taxCollected;
  return {
    txn_count: row.txn_count as number,
    revenue: Number(row.revenue),
    tax_collected: taxCollected,
    fuel_revenue: fuelRevenue,
    fuel_gallons: fuelGallons,
    merch_revenue: merchRevenue,
    avg_price_per_gallon: fuelGallons > 0 ? fuelRevenue / fuelGallons : null,
  };
}

const BUCKET_EXPR: Record<string, string> = {
  hour: `to_char(date AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD"T"HH24:00')`,
  day: `to_char(date AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`,
  month: `to_char(date AT TIME ZONE 'America/Chicago', 'YYYY-MM')`,
  year: `to_char(date AT TIME ZONE 'America/Chicago', 'YYYY')`,
};

export async function getTimeseries(granularity: string, start: string, end: string) {
  const db = sql();
  const bucketExpr = BUCKET_EXPR[granularity] ?? BUCKET_EXPR.day;
  const rows = await db.query(
    `SELECT ${bucketExpr} AS bucket, COUNT(*)::int AS txn_count,
            COALESCE(SUM(total_with_tax), 0) AS revenue
     FROM transactions WHERE date >= $1 AND date < $2
     GROUP BY bucket ORDER BY bucket ASC`,
    [start, end]
  );
  return (rows as any[]).map((r) => ({ ...r, revenue: Number(r.revenue) }));
}

export async function getFuelByGrade(start: string, end: string) {
  const db = sql();
  const rows = await db`
    SELECT l.fuel_grade AS grade,
           COALESCE(SUM(l.fuel_volume), 0) AS gallons,
           COALESCE(SUM(l.line_total), 0) AS revenue,
           COUNT(*)::int AS txn_count
    FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_fuel = true AND t.date >= ${start} AND t.date < ${end}
      AND l.fuel_grade IS NOT NULL
    GROUP BY l.fuel_grade ORDER BY revenue DESC
  `;
  return rows.map((r) => ({ ...r, gallons: Number(r.gallons), revenue: Number(r.revenue) }));
}

export async function getMerchByDepartment(start: string, end: string, limit = 50) {
  const db = sql();
  const rows = await db`
    SELECT l.description AS item, l.dept_number AS dept, l.category AS category,
           COALESCE(SUM(l.qty), 0) AS qty,
           COALESCE(SUM(l.line_total), 0) AS revenue
    FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_fuel = false AND t.date >= ${start} AND t.date < ${end}
    GROUP BY l.description, l.dept_number, l.category ORDER BY revenue DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, qty: Number(r.qty), revenue: Number(r.revenue) }));
}

/** Category-level breakdown (TOBACCO, BEVERAGES, DELI, GROC NOTAX, etc.) -
 * matches the department-wise view already proven out in the Apps Script
 * reporting, using the TLog's own trlCat tag rather than raw item
 * descriptions. Lottery categories are intentionally excluded here (same
 * exclusion list as the reference implementation) since lottery has its
 * own dedicated Sales/Paid Out reporting, not a merchandise category. */
const MERCH_EXCLUDED_CATEGORIES = ["SCRATCH OFF", "LOTTERY", "LOTTERY PO", "DELI WASTE", "GIFT CARD", "FUEL DEPOSIT"];

export async function getMerchByCategory(start: string, end: string) {
  const db = sql();
  const rows = await db.query(
    `SELECT COALESCE(l.category, 'UNCATEGORIZED') AS category,
            COALESCE(SUM(l.line_total), 0) AS revenue,
            COUNT(*)::int AS sale_count
     FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
     WHERE l.is_fuel = false AND t.date >= $1 AND t.date < $2
       AND NOT (COALESCE(l.category, 'UNCATEGORIZED') = ANY($3::text[]))
     GROUP BY COALESCE(l.category, 'UNCATEGORIZED') ORDER BY revenue DESC`,
    [start, end, MERCH_EXCLUDED_CATEGORIES]
  );
  return (rows as any[]).map((r) => ({ ...r, revenue: Number(r.revenue) }));
}

/** Lottery breakdown (Scratch Off, Lottery/Lotto, Paid Out, and the Net
 * figure used to compute "Inside Sales, ex-lottery"). Formula confirmed
 * directly against the reference spreadsheet: Scratch ($25) + Lottery
 * ($6) - Paid Out ($17) = Net Lottery ($14), which matches exactly. Paid
 * Out amounts are stored as negative in the raw TLog data (confirmed by
 * the reference Apps Script's Math.abs() usage), so ABS() is applied the
 * same way here. */
export async function getLotteryBreakdown(start: string, end: string) {
  const db = sql();
  const rows = await db.query(
    `SELECT l.category AS category, COALESCE(SUM(l.line_total), 0) AS amount
     FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
     WHERE t.date >= $1 AND t.date < $2
       AND l.category = ANY($3::text[])
     GROUP BY l.category`,
    [start, end, ["SCRATCH OFF", "LOTTERY", "LOTTERY PO"]]
  );
  const byCategory: Record<string, number> = {};
  for (const r of rows as any[]) byCategory[r.category] = Number(r.amount);

  const scratchSales = byCategory["SCRATCH OFF"] ?? 0;
  const lotterySales = byCategory["LOTTERY"] ?? 0;
  const paidOut = Math.abs(byCategory["LOTTERY PO"] ?? 0);
  const netLottery = scratchSales + lotterySales - paidOut;

  return {
    scratch_sales: scratchSales,
    lottery_sales: lotterySales,
    paid_out: paidOut,
    net_lottery: netLottery,
  };
}

export async function getPaymentMix(start: string, end: string) {
  const db = sql();
  const rows = await db`
    SELECT p.tender_type AS tender, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS count
    FROM transaction_payments p JOIN transactions t ON t.unique_id = p.unique_id
    WHERE t.date >= ${start} AND t.date < ${end} AND p.tender_type != 'Change'
    GROUP BY p.tender_type ORDER BY amount DESC
  `;
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function getPumpActivity(start: string, end: string) {
  const db = sql();
  const rows = await db`
    SELECT l.pump_number AS pump,
           COALESCE(SUM(l.fuel_volume), 0) AS gallons,
           COALESCE(SUM(l.line_total), 0) AS revenue,
           COUNT(*)::int AS txn_count
    FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_fuel = true AND l.pump_number IS NOT NULL
      AND t.date >= ${start} AND t.date < ${end}
    GROUP BY l.pump_number ORDER BY pump ASC
  `;
  return rows.map((r) => ({ ...r, gallons: Number(r.gallons), revenue: Number(r.revenue) }));
}

export async function getStatus() {
  const db = sql();
  const [totalRow] = await db`SELECT COUNT(*)::int AS c FROM transactions`;
  const [lastRow] = await db`SELECT MAX(date) AS d FROM transactions`;
  return {
    total_transactions: totalRow.c as number,
    last_transaction_date: lastRow.d,
  };
}

// ── Extended analytics ──────────────────────────────────────

/** Revenue/transactions grouped by hour-of-day (0-23, Central time),
 * collapsed across every day in the range - answers "when are we
 * busiest," not "how much on which specific day." */
export async function getHourOfDayBreakdown(start: string, end: string) {
  const db = sql();
  const rows = await db.query(
    `SELECT EXTRACT(HOUR FROM date AT TIME ZONE 'America/Chicago')::int AS hour,
            COUNT(*)::int AS txn_count,
            COALESCE(SUM(total_with_tax), 0) AS revenue
     FROM transactions WHERE date >= $1 AND date < $2
     GROUP BY hour ORDER BY hour ASC`,
    [start, end]
  );
  // Always return all 24 hours, zero-filled, so the chart's x-axis never
  // has gaps just because a quiet hour had zero transactions.
  const byHour = new Map((rows as any[]).map((r) => [r.hour, r]));
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    txn_count: byHour.get(h)?.txn_count ?? 0,
    revenue: Number(byHour.get(h)?.revenue ?? 0),
  }));
}

/** Revenue/transactions grouped by day-of-week (0=Sunday..6=Saturday,
 * Central time), collapsed across every week in the range. */
export async function getDayOfWeekBreakdown(start: string, end: string) {
  const db = sql();
  const rows = await db.query(
    `SELECT EXTRACT(DOW FROM date AT TIME ZONE 'America/Chicago')::int AS dow,
            COUNT(*)::int AS txn_count,
            COALESCE(SUM(total_with_tax), 0) AS revenue
     FROM transactions WHERE date >= $1 AND date < $2
     GROUP BY dow ORDER BY dow ASC`,
    [start, end]
  );
  const byDow = new Map((rows as any[]).map((r) => [r.dow, r]));
  const LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return Array.from({ length: 7 }, (_, d) => ({
    dow: d,
    label: LABELS[d],
    txn_count: byDow.get(d)?.txn_count ?? 0,
    revenue: Number(byDow.get(d)?.revenue ?? 0),
  }));
}

/** KPIs for the period of equal length immediately BEFORE `start` - lets
 * the dashboard show "+12% vs previous period" style comparisons. */
export async function getPreviousPeriodKpis(start: string, end: string) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const spanMs = endMs - startMs;
  const prevEnd = new Date(startMs).toISOString();
  const prevStart = new Date(startMs - spanMs).toISOString();
  return getKpis(prevStart, prevEnd);
}

/** One row per calendar day (Central time) in the range - the "ledger"
 * view for scanning/sorting day by day, independent of the live feed. */
export async function getDailyLedger(start: string, end: string) {
  const db = sql();

  const txnRows = await db.query(
    `SELECT to_char(date AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS txn_count,
            COALESCE(SUM(total_with_tax), 0) AS revenue,
            COALESCE(SUM(total_tax), 0) AS tax_collected
     FROM transactions
     WHERE date >= $1 AND date < $2
     GROUP BY day`,
    [start, end]
  );

  const fuelRows = await db.query(
    `SELECT to_char(t.date AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS day,
            COALESCE(SUM(l.fuel_volume), 0) AS fuel_gallons,
            COALESCE(SUM(l.line_total), 0) AS fuel_revenue
     FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
     WHERE l.is_fuel = true AND t.date >= $1 AND t.date < $2
     GROUP BY day`,
    [start, end]
  );

  const fuelByDay = new Map((fuelRows as any[]).map((r) => [r.day, r]));
  return (txnRows as any[])
    .map((r) => ({
      day: r.day as string,
      txn_count: r.txn_count as number,
      revenue: Number(r.revenue),
      tax_collected: Number(r.tax_collected),
      fuel_gallons: Number(fuelByDay.get(r.day)?.fuel_gallons ?? 0),
      fuel_revenue: Number(fuelByDay.get(r.day)?.fuel_revenue ?? 0),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Cards seen more than once in the range, by last 4 digits - a simple
 * repeat-customer signal. Cash payments have no card and are excluded. */
export async function getRepeatCustomers(start: string, end: string, minVisits = 2, limit = 20) {
  const db = sql();
  const rows = await db.query(
    `SELECT p.card_last4 AS card_last4,
            COUNT(*)::int AS visits,
            COALESCE(SUM(p.amount), 0) AS total_spent,
            MAX(t.date) AS last_seen
     FROM transaction_payments p
     JOIN transactions t ON t.unique_id = p.unique_id
     WHERE p.card_last4 IS NOT NULL AND t.date >= $1 AND t.date < $2
     GROUP BY p.card_last4
     HAVING COUNT(*) >= $3
     ORDER BY visits DESC, total_spent DESC
     LIMIT $4`,
    [start, end, minVisits, limit]
  );
  return (rows as any[]).map((r) => ({ ...r, total_spent: Number(r.total_spent) }));
}

/** Flags any pump that's active elsewhere in the data but saw NO fuel
 * sales in this specific range - a simple "might be down" signal, not a
 * diagnosis (could just be legitimately quiet, but worth a glance). */
export async function getPumpHealthFlags(start: string, end: string) {
  const db = sql();
  // "Which pumps exist at all" barely ever changes, so there's no reason
  // to scan the ENTIRE table's history (which only ever grows) to answer
  // it - bounded to the last 90 days, which is more than enough to catch
  // any pump that's genuinely in use, while keeping this query's cost
  // flat over time instead of slowly worsening every month.
  const recentWindowStart = new Date(new Date(end).getTime() - 90 * 24 * 3600 * 1000).toISOString();
  const allPumps = await db`
    SELECT DISTINCT pump_number FROM transaction_lines l
    JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_fuel = true AND l.pump_number IS NOT NULL AND t.date >= ${recentWindowStart}
  `;
  const activePumps = await db.query(
    `SELECT DISTINCT l.pump_number
     FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
     WHERE l.is_fuel = true AND l.pump_number IS NOT NULL
       AND t.date >= $1 AND t.date < $2`,
    [start, end]
  );
  const activeSet = new Set((activePumps as any[]).map((r) => r.pump_number));
  return allPumps
    .map((r) => r.pump_number as number)
    .filter((p) => !activeSet.has(p))
    .sort((a, b) => a - b);
}

// ── Smart Insights: forecasting and anomaly detection ────────

/** Projects today's likely full-day total, based on how the SAME weekday
 * has historically unfolded hour by hour - not just "average Wednesday
 * total," but "what fraction of a typical Wednesday's revenue is usually
 * in by this exact hour," applied to what's actually come in so far
 * today. Verified against synthetic data with a known ground truth
 * before being wired to real queries: 0% error when the underlying
 * intraday shape is consistent, which is exactly what this technique
 * assumes. Returns null if there isn't enough historical data yet (a
 * brand new deployment, or fewer than 2 same-weekday days on record). */
export async function getTodayForecast(now: Date) {
  const db = sql();
  const centralNowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => centralNowParts.find((p) => p.type === t)?.value ?? "0";
  const todayStr = `${get("year")}-${get("month")}-${get("day")}`;
  const rawHour = parseInt(get("hour"), 10);
  const currentHour = rawHour === 24 ? 0 : rawHour;
  const todayWeekday = new Date(`${todayStr}T12:00:00`).getDay(); // noon avoids any DST/boundary edge case

  // Wide lookback window (90 days) comfortably contains at least ~12
  // occurrences of any given weekday to average across.
  const lookbackStart = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  const rows = await db.query(
    `SELECT to_char(date AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS day,
            EXTRACT(HOUR FROM date AT TIME ZONE 'America/Chicago')::int AS hour,
            COALESCE(SUM(total_with_tax), 0) AS hour_revenue
     FROM transactions WHERE date >= $1
     GROUP BY day, hour ORDER BY day, hour`,
    [lookbackStart]
  );

  const byDay = new Map<string, number[]>(); // day -> revenue per hour (24 slots)
  for (const r of rows as any[]) {
    if (!byDay.has(r.day)) byDay.set(r.day, new Array(24).fill(0));
    byDay.get(r.day)![r.hour] = Number(r.hour_revenue);
  }

  const todayHourly = byDay.get(todayStr) ?? new Array(24).fill(0);
  const revenueSoFar = todayHourly.slice(0, currentHour + 1).reduce((a, b) => a + b, 0);

  // Same weekday, most recent 12 occurrences, excluding today itself.
  const sameWeekdayDays = Array.from(byDay.keys())
    .filter((d) => d !== todayStr && new Date(`${d}T12:00:00`).getDay() === todayWeekday)
    .sort()
    .slice(-12);

  if (sameWeekdayDays.length < 2 || revenueSoFar === 0) return null;

  const fractionsAtCurrentHour: number[] = [];
  const historicalFullDayTotals: number[] = [];
  for (const d of sameWeekdayDays) {
    const hourly = byDay.get(d)!;
    const dayTotal = hourly.reduce((a, b) => a + b, 0);
    if (dayTotal <= 0) continue;
    const cumulativeAtHour = hourly.slice(0, currentHour + 1).reduce((a, b) => a + b, 0);
    fractionsAtCurrentHour.push(cumulativeAtHour / dayTotal);
    historicalFullDayTotals.push(dayTotal);
  }
  if (fractionsAtCurrentHour.length < 2) return null;

  const avgFraction = fractionsAtCurrentHour.reduce((a, b) => a + b, 0) / fractionsAtCurrentHour.length;
  if (avgFraction <= 0) return null;

  const projectedTotal = revenueSoFar / avgFraction;
  const avgHistoricalTotal =
    historicalFullDayTotals.reduce((a, b) => a + b, 0) / historicalFullDayTotals.length;

  return {
    revenue_so_far: revenueSoFar,
    current_hour: currentHour,
    typical_pace_fraction: avgFraction,
    projected_total: projectedTotal,
    historical_days_used: fractionsAtCurrentHour.length,
    avg_historical_total_same_weekday: avgHistoricalTotal,
    // How today's pace compares to the historical norm for this weekday -
    // the basis for a "trending below/above normal" anomaly alert.
    pct_vs_historical_average: avgHistoricalTotal > 0 ? (projectedTotal / avgHistoricalTotal - 1) * 100 : null,
  };
}

/** A handful of concrete, explainable anomaly checks over a range -
 * deliberately simple, threshold-based rules (not a black-box model) so
 * every alert can say exactly why it fired. */
export async function getAnomalies(start: string, end: string) {
  const db = sql();
  const alerts: { severity: "warning" | "info"; message: string }[] = [];

  // 1. Fuel price outliers: today's $/gal for each grade vs a 30-day
  // trailing average for that SAME grade - catches a mis-keyed price or a
  // grade being sold at yesterday's stale price.
  const priceCheck = await db.query(
    `WITH today_prices AS (
       SELECT l.fuel_grade, SUM(l.line_total) / NULLIF(SUM(l.fuel_volume), 0) AS today_price
       FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
       WHERE l.is_fuel = true AND l.fuel_grade IS NOT NULL AND t.date >= $1 AND t.date < $2
       GROUP BY l.fuel_grade
     ),
     trailing_prices AS (
       SELECT l.fuel_grade, SUM(l.line_total) / NULLIF(SUM(l.fuel_volume), 0) AS trailing_price
       FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
       WHERE l.is_fuel = true AND l.fuel_grade IS NOT NULL
         AND t.date >= $1::timestamptz - interval '30 days' AND t.date < $1
       GROUP BY l.fuel_grade
     )
     SELECT tp.fuel_grade, tp.today_price, tr.trailing_price
     FROM today_prices tp JOIN trailing_prices tr ON tr.fuel_grade = tp.fuel_grade
     WHERE tr.trailing_price > 0
       AND ABS(tp.today_price - tr.trailing_price) / tr.trailing_price > 0.15`,
    [start, end]
  );
  for (const r of priceCheck as any[]) {
    const today = Number(r.today_price), trailing = Number(r.trailing_price);
    const dir = today > trailing ? "higher" : "lower";
    alerts.push({
      severity: "warning",
      message: `${r.fuel_grade} is averaging $${today.toFixed(3)}/gal today, ${dir} than its usual $${trailing.toFixed(3)}/gal - worth checking the posted price is correct.`,
    });
  }

  // 2. Void rate spike: today's void-ticket rate vs a 30-day trailing average.
  const voidCheck = await db.query(
    `WITH today_stats AS (
       SELECT (SELECT COUNT(*) FROM void_transactions WHERE date >= $1 AND date < $2) AS voids,
              (SELECT COUNT(*) FROM transactions WHERE date >= $1 AND date < $2) AS txns
     ),
     trailing_stats AS (
       SELECT (SELECT COUNT(*) FROM void_transactions WHERE date >= $1::timestamptz - interval '30 days' AND date < $1) AS voids,
              (SELECT COUNT(*) FROM transactions WHERE date >= $1::timestamptz - interval '30 days' AND date < $1) AS txns
     )
     SELECT t.voids AS today_voids, t.txns AS today_txns, tr.voids AS trailing_voids, tr.txns AS trailing_txns
     FROM today_stats t, trailing_stats tr`,
    [start, end]
  );
  const vr = (voidCheck as any[])[0];
  if (vr && Number(vr.today_txns) >= 20 && Number(vr.trailing_txns) >= 50) {
    const todayRate = Number(vr.today_voids) / Number(vr.today_txns);
    const trailingRate = Number(vr.trailing_voids) / Number(vr.trailing_txns);
    if (trailingRate > 0 && todayRate > trailingRate * 2.5) {
      alerts.push({
        severity: "warning",
        message: `Voids are running higher than usual today (${(todayRate * 100).toFixed(1)}% of transactions vs a typical ${(trailingRate * 100).toFixed(1)}%) - worth a look at the Voids panel.`,
      });
    }
  }

  // 3. Unusually large single transaction: more than 5x the trailing
  // average ticket size - could be a real large sale, or a data entry error.
  const bigTxnCheck = await db.query(
    `WITH trailing_avg AS (
       SELECT AVG(total_with_tax) AS avg_ticket
       FROM transactions WHERE date >= $1::timestamptz - interval '30 days' AND date < $1
     )
     SELECT t.unique_id, t.tr_seq, t.total_with_tax, ta.avg_ticket
     FROM transactions t, trailing_avg ta
     WHERE t.date >= $1 AND t.date < $2 AND ta.avg_ticket > 0
       AND t.total_with_tax > ta.avg_ticket * 5
     ORDER BY t.total_with_tax DESC LIMIT 5`,
    [start, end]
  );
  for (const r of bigTxnCheck as any[]) {
    alerts.push({
      severity: "info",
      message: `Transaction #${r.tr_seq ?? r.unique_id.slice(-6)} was $${Number(r.total_with_tax).toFixed(2)}, well above the usual ~$${Number(r.avg_ticket).toFixed(2)} ticket - just flagging for awareness, not necessarily a problem.`,
    });
  }

  return alerts;
}

/** New-record tracking: is TODAY (so far) on pace to be the best day on
 * record for revenue, or the best for any single fuel grade's gallons?
 * A simple, motivating signal - compares today's live total against the
 * best CLOSED day on record (never counts today itself as a past record). */
export async function getRecordCheck(start: string, end: string) {
  const db = sql();
  const [bestDayRow] = await db.query(
    `SELECT to_char(date AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS day,
            SUM(total_with_tax) AS total
     FROM transactions WHERE date < $1
     GROUP BY day ORDER BY total DESC LIMIT 1`,
    [start]
  );
  const [todayRow] = await db`
    SELECT COALESCE(SUM(total_with_tax), 0) AS total FROM transactions WHERE date >= ${start} AND date < ${end}
  `;
  if (!bestDayRow) return null;
  const todayTotal = Number(todayRow.total);
  const bestTotal = Number(bestDayRow.total);
  return {
    today_total: todayTotal,
    best_day: bestDayRow.day,
    best_day_total: bestTotal,
    is_new_record: bestTotal > 0 && todayTotal > bestTotal,
  };
}

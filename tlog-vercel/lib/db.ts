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
import type { Transaction } from "./tlogParser";
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
      date            TIMESTAMPTZ NOT NULL,
      cashier         TEXT,
      till            INTEGER,
      total_no_tax    NUMERIC,
      total_with_tax  NUMERIC,
      total_tax       NUMERIC,
      ingested_at     TIMESTAMPTZ DEFAULT now()
    )
  `;
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
      pump_number     INTEGER
    )
  `;
  // Safe to run even if the table already existed before this column was added.
  await db`ALTER TABLE transaction_lines ADD COLUMN IF NOT EXISTS category TEXT`;
  await db`CREATE INDEX IF NOT EXISTS idx_lines_unique_id ON transaction_lines(unique_id)`;
  await db`CREATE INDEX IF NOT EXISTS idx_lines_is_fuel ON transaction_lines(is_fuel)`;
  await db`CREATE INDEX IF NOT EXISTS idx_lines_category ON transaction_lines(category)`;

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

  // Step 2: bulk-insert all new transactions in ONE query via unnest().
  await db.query(
    `INSERT INTO transactions
       (unique_id, source_file, trans_type, pos_num, date, cashier, till,
        total_no_tax, total_with_tax, total_tax)
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::int[], $5::timestamptz[],
       $6::text[], $7::int[], $8::numeric[], $9::numeric[], $10::numeric[]
     )
     ON CONFLICT (unique_id) DO NOTHING`,
    [
      newTxns.map((t) => t.unique_id),
      newTxns.map((t) => t.source_file),
      newTxns.map((t) => t.trans_type),
      newTxns.map((t) => t.pos_num),
      newTxns.map((t) => t.date),
      newTxns.map((t) => t.cashier),
      newTxns.map((t) => t.till),
      newTxns.map((t) => t.total_no_tax),
      newTxns.map((t) => t.total_with_tax),
      newTxns.map((t) => t.total_tax),
    ]
  );

  // Step 3: flatten every line item across ALL new transactions into
  // parallel arrays, and bulk-insert them in ONE query.
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

  for (const txn of newTxns) {
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
    }
  }
  if (lineOwners.length > 0) {
    await db.query(
      `INSERT INTO transaction_lines
         (unique_id, dept_number, dept_type, category, description, qty, unit_price,
          line_total, is_fuel, fuel_grade, fuel_volume, pump_number)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[],
         $7::numeric[], $8::numeric[], $9::boolean[], $10::text[], $11::numeric[], $12::int[]
       )`,
      [
        lineOwners, lineDeptNum, lineDeptType, lineCategory, lineDesc, lineQty,
        lineUnitPrice, lineTotal, lineIsFuel, lineFuelGrade, lineFuelVolume, linePumpNumber,
      ]
    );
  }

  // Step 4: same bulk approach for payments.
  const payOwners: string[] = [];
  const payTender: string[] = [];
  const payAmount: (number | null)[] = [];
  const payCard: (string | null)[] = [];
  for (const txn of newTxns) {
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

export async function getLiveFeed(limit = 50) {
  const db = sql();
  const rows = await db`
    SELECT unique_id, trans_type, pos_num, date, cashier, total_with_tax
    FROM transactions ORDER BY date DESC LIMIT ${limit}
  `;
  const out = [];
  for (const r of rows) {
    const lines = await db`
      SELECT description, category, is_fuel, fuel_grade, fuel_volume, pump_number, line_total
      FROM transaction_lines WHERE unique_id = ${r.unique_id as string}
    `;
    const payments = await db`
      SELECT tender_type, amount FROM transaction_payments WHERE unique_id = ${r.unique_id as string}
    `;
    out.push({
      ...r,
      total_with_tax: Number(r.total_with_tax),
      lines: lines.map((l) => ({
        ...l,
        fuel_volume: l.fuel_volume === null ? null : Number(l.fuel_volume),
        line_total: l.line_total === null ? null : Number(l.line_total),
      })),
      payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    });
  }
  return out;
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
  return {
    txn_count: row.txn_count as number,
    revenue: Number(row.revenue),
    tax_collected: Number(row.tax_collected),
    fuel_revenue: fuelRevenue,
    fuel_gallons: fuelGallons,
    merch_revenue: Number(row.revenue) - fuelRevenue,
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

export async function getMerchByDepartment(start: string, end: string, limit = 15) {
  const db = sql();
  const rows = await db`
    SELECT l.description AS item, l.dept_number AS dept,
           COALESCE(SUM(l.qty), 0) AS qty,
           COALESCE(SUM(l.line_total), 0) AS revenue
    FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_fuel = false AND t.date >= ${start} AND t.date < ${end}
    GROUP BY l.description, l.dept_number ORDER BY revenue DESC LIMIT ${limit}
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
  const files = await db`
    SELECT filename, processed_at, txn_count FROM processed_files ORDER BY processed_at DESC
  `;
  return {
    total_transactions: totalRow.c as number,
    last_transaction_date: lastRow.d,
    files_processed: files,
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
  const allPumps = await db`
    SELECT DISTINCT pump_number FROM transaction_lines
    WHERE is_fuel = true AND pump_number IS NOT NULL
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

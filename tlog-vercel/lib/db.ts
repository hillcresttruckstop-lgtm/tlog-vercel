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
  await db`CREATE INDEX IF NOT EXISTS idx_lines_unique_id ON transaction_lines(unique_id)`;
  await db`CREATE INDEX IF NOT EXISTS idx_lines_is_fuel ON transaction_lines(is_fuel)`;

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
      txn_count       INTEGER
    )
  `;
}

export function fileHash(raw: Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function isFileUnchanged(filename: string, hash: string): Promise<boolean> {
  const db = sql();
  const rows = await db`SELECT file_hash FROM processed_files WHERE filename = ${filename}`;
  return rows.length > 0 && rows[0].file_hash === hash;
}

export async function markFileProcessed(filename: string, hash: string, txnCount: number) {
  const db = sql();
  await db`
    INSERT INTO processed_files (filename, file_hash, processed_at, txn_count)
    VALUES (${filename}, ${hash}, now(), ${txnCount})
    ON CONFLICT (filename) DO UPDATE SET
      file_hash = excluded.file_hash,
      processed_at = now(),
      txn_count = excluded.txn_count
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
         (unique_id, dept_number, dept_type, description, qty, unit_price,
          line_total, is_fuel, fuel_grade, fuel_volume, pump_number)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[],
         $6::numeric[], $7::numeric[], $8::boolean[], $9::text[], $10::numeric[], $11::int[]
       )`,
      [
        lineOwners, lineDeptNum, lineDeptType, lineDesc, lineQty,
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
      SELECT description, is_fuel, fuel_grade, fuel_volume, pump_number, line_total
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
    SELECT COUNT(*)::int AS txn_count, COALESCE(SUM(total_with_tax), 0) AS revenue
    FROM transactions WHERE date >= ${start} AND date < ${end}
  `;
  const [fuelRow] = await db`
    SELECT COALESCE(SUM(l.line_total), 0) AS fuel_revenue,
           COALESCE(SUM(l.fuel_volume), 0) AS fuel_gallons
    FROM transaction_lines l JOIN transactions t ON t.unique_id = l.unique_id
    WHERE l.is_fuel = true AND t.date >= ${start} AND t.date < ${end}
  `;
  return {
    txn_count: row.txn_count as number,
    revenue: Number(row.revenue),
    fuel_revenue: Number(fuelRow.fuel_revenue),
    fuel_gallons: Number(fuelRow.fuel_gallons),
    merch_revenue: Number(row.revenue) - Number(fuelRow.fuel_revenue),
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

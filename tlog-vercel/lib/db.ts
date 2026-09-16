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
  const db = sql();
  let newCount = 0;

  for (const txn of transactions) {
    const inserted = await db`
      INSERT INTO transactions
        (unique_id, source_file, trans_type, pos_num, date, cashier, till,
         total_no_tax, total_with_tax, total_tax)
      VALUES
        (${txn.unique_id}, ${txn.source_file}, ${txn.trans_type}, ${txn.pos_num},
         ${txn.date}, ${txn.cashier}, ${txn.till},
         ${txn.total_no_tax}, ${txn.total_with_tax}, ${txn.total_tax})
      ON CONFLICT (unique_id) DO NOTHING
      RETURNING unique_id
    `;
    if (inserted.length === 0) continue; // already had this one - skip lines/payments too
    newCount++;

    for (const line of txn.lines) {
      await db`
        INSERT INTO transaction_lines
          (unique_id, dept_number, dept_type, description, qty, unit_price,
           line_total, is_fuel, fuel_grade, fuel_volume, pump_number)
        VALUES
          (${txn.unique_id}, ${line.dept_number}, ${line.dept_type}, ${line.description},
           ${line.qty}, ${line.unit_price}, ${line.line_total}, ${line.is_fuel},
           ${line.fuel_grade}, ${line.fuel_volume}, ${line.pump_number})
      `;
    }
    for (const pay of txn.payments) {
      await db`
        INSERT INTO transaction_payments (unique_id, tender_type, amount, card_last4)
        VALUES (${txn.unique_id}, ${pay.tender_type}, ${pay.amount}, ${pay.card_last4})
      `;
    }
  }
  return newCount;
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
  hour: "to_char(date, 'YYYY-MM-DD\"T\"HH24:00')",
  day: "to_char(date, 'YYYY-MM-DD')",
  month: "to_char(date, 'YYYY-MM')",
  year: "to_char(date, 'YYYY')",
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

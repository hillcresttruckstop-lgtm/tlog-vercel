/**
 * /api/admin/diagnose
 * =====================
 * Finds the EXACT transaction(s) where the sum of their own stored line
 * items doesn't match their own recorded total_with_tax - the same
 * "tie-out" check the reference Apps Script does. If lines were
 * duplicated for a transaction (whatever the cause), that transaction's
 * line-sum will be roughly double its real total_with_tax, and this
 * finds it directly instead of guessing from aggregate numbers.
 *
 * Protected by the same secret as /api/ingest and /api/admin/reset -
 * this only reads data, never modifies anything.
 */

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.INGEST_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
  const param = req.nextUrl.searchParams.get("secret");
  return param === expected;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ error: "DATABASE_URL is not set." }, { status: 500 });
  }
  const db = neon(url);

  const start = req.nextUrl.searchParams.get("start") ?? "2026-01-01T00:00:00Z";
  const end = req.nextUrl.searchParams.get("end") ?? "2026-12-31T23:59:59Z";

  // 1. Does the transactions table actually have a real unique constraint
  // on unique_id? If an old table predates the current schema, this could
  // silently be missing even though our code assumes it's there.
  const constraintCheck = await db`
    SELECT conname, contype
    FROM pg_constraint
    WHERE conrelid = 'transactions'::regclass AND contype IN ('p', 'u')
  `;

  // 2. Any transactions.unique_id appearing more than once (should be
  // structurally impossible with a real primary key, but check directly).
  const dupeTxnCheck = await db`
    SELECT unique_id, COUNT(*)::int AS c FROM transactions
    GROUP BY unique_id HAVING COUNT(*) > 1 LIMIT 10
  `;

  // 3. The real tie-out check: for each transaction, does the sum of its
  // own lines (fuel + merch) roughly match its own recorded total? A
  // transaction with duplicated lines will show a line-sum far above its
  // own total_with_tax - the exact smoking gun, not an aggregate guess.
  const tieOutIssues = await db.query(
    `SELECT t.unique_id, t.tr_seq, t.date, t.total_with_tax,
            COALESCE(SUM(l.line_total), 0) AS line_sum,
            COUNT(l.id)::int AS line_count
     FROM transactions t
     JOIN transaction_lines l ON l.unique_id = t.unique_id
     WHERE t.date >= $1 AND t.date < $2
     GROUP BY t.unique_id, t.tr_seq, t.date, t.total_with_tax
     HAVING ABS(COALESCE(SUM(l.line_total), 0) - t.total_with_tax) > 1.00
     ORDER BY ABS(COALESCE(SUM(l.line_total), 0) - t.total_with_tax) DESC
     LIMIT 20`,
    [start, end]
  );

  // 4. For the single worst offender, pull its actual stored line rows
  // directly, so we can see literal duplicate rows if that's what's there.
  let worstOffenderLines: any[] = [];
  if ((tieOutIssues as any[]).length > 0) {
    const worstId = (tieOutIssues as any[])[0].unique_id;
    worstOffenderLines = await db`
      SELECT id, description, category, is_fuel, fuel_grade, fuel_volume, line_total
      FROM transaction_lines WHERE unique_id = ${worstId} ORDER BY id
    `;
  }

  return NextResponse.json({
    constraints_on_transactions_table: constraintCheck,
    duplicate_unique_id_rows_in_transactions: dupeTxnCheck,
    tie_out_mismatches_found: (tieOutIssues as any[]).length,
    tie_out_mismatches: tieOutIssues,
    worst_offender_actual_line_rows: worstOffenderLines,
  });
}

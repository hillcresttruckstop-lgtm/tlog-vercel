/**
 * /api/admin/reset
 * ==================
 * Wipes every stored transaction/line/payment/processed-file record so
 * the next ingest cycles rebuild everything from scratch, through
 * whatever version of the parser is currently deployed.
 *
 * This exists specifically for the situation where the PARSING LOGIC
 * itself was fixed (e.g. correctly excluding fuel-prepay duplicate
 * lines), but the database still holds old data that was ingested under
 * the previous, buggy logic - since transactions are only ever inserted
 * once and never updated, fixing the parser alone does nothing for data
 * that's already stored. This is the reset button for that situation.
 *
 * Protected by the same INGEST_SECRET as /api/ingest - this is a
 * destructive action, not something to expose casually.
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

  // A second, explicit confirmation flag - this deletes everything, so a
  // bare hit on the URL (e.g. an accidental click, a browser prefetch)
  // should never be enough to trigger it on its own.
  if (req.nextUrl.searchParams.get("confirm") !== "yes-wipe-everything") {
    return NextResponse.json({
      error: "Add &confirm=yes-wipe-everything to the URL to actually run this. " +
        "This permanently deletes every stored transaction/line/payment/processed-file " +
        "record. Your next ingest run(s) will re-pull and re-parse everything from " +
        "Google Drive from scratch, which will take a number of cycles to fully catch up " +
        "again (today's live data will reappear quickly since it's always processed first; " +
        "historical months will take longer).",
    }, { status: 400 });
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ error: "DATABASE_URL is not set." }, { status: 500 });
  }
  const db = neon(url);

  // Order matters: child tables (foreign keys referencing transactions)
  // first, then transactions itself. processed_files is independent but
  // cleared too, since it's what makes the next ingest skip files it
  // thinks it already has - clearing it forces everything to be
  // re-read from Drive and re-parsed with the current parser logic.
  const linesDeleted = await db`DELETE FROM transaction_lines`;
  const paymentsDeleted = await db`DELETE FROM transaction_payments`;
  const txnsDeleted = await db`DELETE FROM transactions`;
  const filesDeleted = await db`DELETE FROM processed_files`;

  return NextResponse.json({
    ok: true,
    message: "All stored data wiped. Trigger /api/ingest (or wait for the next cron run) " +
      "to start rebuilding from Google Drive through the current parser.",
  });
}

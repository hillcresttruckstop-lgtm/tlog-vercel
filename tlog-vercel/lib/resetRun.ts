/**
 * resetRun.ts
 * ============
 * The actual "wipe every stored record" logic - factored out of
 * /api/admin/reset so it can be reused by the dashboard's own Reset &
 * Rebuild button (session-protected, no secret exposed to the browser)
 * without duplicating it. Same pattern as ingestRun.ts.
 */

import { neon } from "@neondatabase/serverless";
import { initSchema } from "./db";

export async function runReset(): Promise<{ ok: true; message: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  await initSchema(); // guarantees every table (including newer ones like void_transactions) exists first
  const db = neon(url);

  // Order matters: child tables (foreign keys referencing transactions)
  // first, then transactions itself. processed_files is independent but
  // cleared too, since it's what makes the next ingest skip files it
  // thinks it already has - clearing it forces everything to be
  // re-read from Drive and re-parsed with the current parser logic.
  await db`DELETE FROM transaction_lines`;
  await db`DELETE FROM transaction_payments`;
  await db`DELETE FROM transactions`;
  await db`DELETE FROM processed_files`;
  await db`DELETE FROM void_transactions`;

  return {
    ok: true,
    message: "All stored data wiped. Rebuilding from Google Drive through the current parser.",
  };
}

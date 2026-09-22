/**
 * /api/sync
 * ==========
 * The dashboard's own "Sync" button calls this. Unlike /api/ingest (which
 * is protected by a secret so an external scheduler can call it), this
 * route relies on the normal login session - proxy.ts already requires
 * you to be logged in for any path that isn't explicitly public, and this
 * one isn't, so there's no secret to expose to the browser at all.
 *
 * Runs the exact same ingestion logic as the scheduled job (lib/ingestRun.ts).
 */

import { NextResponse } from "next/server";
import { runIngest } from "@/lib/ingestRun";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  try {
    const result = await runIngest();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: `Sync failed: ${err.message}` }, { status: 500 });
  }
}

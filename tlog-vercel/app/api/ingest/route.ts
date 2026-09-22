/**
 * /api/ingest
 * ============
 * Called by your free external scheduler (cron-job.org / GitHub Actions)
 * every ~15 minutes. Protected by a shared secret so random internet
 * traffic can't trigger (and bill) your ingestion - pass it as
 * ?secret=... or an Authorization: Bearer ... header.
 *
 * The actual work (list Drive, skip unchanged, download+parse+store) now
 * lives in lib/ingestRun.ts, shared with /api/sync (the button on the
 * dashboard itself) so both routes behave identically.
 */

import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/lib/ingestRun";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel's own limit - separate from cron-job.org's 30s

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.INGEST_SECRET;
  if (!expected) return false; // fail closed if not configured
  const header = req.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
  const param = req.nextUrl.searchParams.get("secret");
  return param === expected;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runIngest();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: `Ingest failed: ${err.message}` }, { status: 500 });
  }
}

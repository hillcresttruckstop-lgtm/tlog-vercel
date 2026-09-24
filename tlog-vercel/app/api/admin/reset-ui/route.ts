/**
 * /api/admin/reset-ui
 * =====================
 * The dashboard's own "Reset & Rebuild" button calls this. Unlike
 * /api/admin/reset (protected by a secret so it can be hit as a plain
 * URL), this relies on the normal login session - proxy.ts already
 * requires you to be logged in for any path that isn't explicitly
 * public, and this one isn't, so no secret needs to reach the browser.
 *
 * Still requires an explicit typed confirmation in the request body on
 * top of the session check - being logged in is enough to see the
 * button, but a second, deliberate confirmation is required before
 * anything actually gets deleted, since this action is irreversible.
 *
 * FIXED: this used to also run a full ingest cycle in the SAME request
 * right after the wipe, so the button felt like one click did both
 * steps. Confirmed this was a real bug: ingest alone can take 30+
 * seconds right after a full wipe (the most work it will ever have to
 * do), and combined with the reset itself, the whole request could
 * exceed Vercel's 60-second function limit - the platform kills it
 * mid-execution with no clean error, which is exactly what happened: the
 * wipe completed but the re-ingest got cut off partway, leaving the
 * dashboard showing zeros with the Sync button stuck. This route now
 * ONLY does the (fast, just DELETE statements) reset - the dashboard
 * itself calls /api/sync as a SEPARATE follow-up request afterward,
 * keeping each individual request comfortably inside its own time
 * budget instead of stacking both into one.
 */

import { NextRequest, NextResponse } from "next/server";
import { runReset } from "@/lib/resetRun";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // no body / invalid JSON - falls through to the confirmation check below, which will correctly reject it
  }

  if (body?.confirm !== "RESET") {
    return NextResponse.json(
      { error: 'Missing confirmation. Send {"confirm":"RESET"} in the request body.' },
      { status: 400 }
    );
  }

  try {
    const result = await runReset();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: `Reset failed: ${err.message}` }, { status: 500 });
  }
}

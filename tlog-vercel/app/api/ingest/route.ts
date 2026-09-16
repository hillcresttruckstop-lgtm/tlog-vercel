/**
 * /api/ingest
 * ============
 * Called by your free external scheduler (cron-job.org / GitHub Actions)
 * every ~15 minutes. Lists TLog files in the Drive folder, and for any
 * that are new or changed since last time (by content hash), downloads,
 * parses, and stores them.
 *
 * Protected by a shared secret so random internet traffic can't trigger
 * (and bill) your ingestion - pass it as ?secret=... or an
 * Authorization: Bearer ... header.
 */

import { NextRequest, NextResponse } from "next/server";
import { listTlogFiles, downloadFile } from "@/lib/driveClient";
import { parseTlog } from "@/lib/tlogParser";
import {
  initSchema,
  fileHash,
  isFileUnchanged,
  ingestTransactions,
  markFileProcessed,
} from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds - raise via Vercel Pro if your backlog needs longer

// Cap files processed per invocation so a huge backlog of historical
// archives can't blow past the function's time limit in one go - it'll
// just finish catching up over the next few cron cycles instead.
const MAX_FILES_PER_RUN = 20;

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

  await initSchema();

  let files;
  try {
    files = await listTlogFiles();
  } catch (err: any) {
    return NextResponse.json({ error: `Drive list failed: ${err.message}` }, { status: 500 });
  }

  const results: any[] = [];
  let filesChanged = 0;
  let newTxnTotal = 0;
  let processedThisRun = 0;

  for (const file of files) {
    if (processedThisRun >= MAX_FILES_PER_RUN) break;

    let raw: Buffer;
    try {
      raw = await downloadFile(file.id);
    } catch (err: any) {
      results.push({ file: file.name, error: `download failed: ${err.message}` });
      continue;
    }

    const hash = fileHash(raw);
    if (await isFileUnchanged(file.name, hash)) continue; // no new data in this file

    processedThisRun++;

    let txns;
    try {
      txns = parseTlog(raw, file.name);
    } catch (err: any) {
      results.push({ file: file.name, error: `parse failed: ${err.message}` });
      continue;
    }

    const newCount = await ingestTransactions(txns);
    await markFileProcessed(file.name, hash, txns.length);

    filesChanged++;
    newTxnTotal += newCount;
    results.push({ file: file.name, transactions_in_file: txns.length, new: newCount });
  }

  return NextResponse.json({
    ok: true,
    files_seen: files.length,
    files_changed: filesChanged,
    new_transactions: newTxnTotal,
    remaining_backlog: files.length - processedThisRun > 0 && processedThisRun >= MAX_FILES_PER_RUN,
    details: results,
  });
}

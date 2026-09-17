/**
 * /api/ingest
 * ============
 * Called by your free external scheduler (cron-job.org / GitHub Actions)
 * every ~15 minutes. Lists TLog files in the Drive folder, and for any
 * that are new or changed since last time, downloads, parses, and
 * stores them.
 *
 * Speed matters here: cron-job.org's free tier gives up and marks a run
 * "failed (timeout)" after 30 seconds, even if the underlying job is
 * still working. Two things keep this comfortably under that:
 *   1. Google Drive's own `modifiedTime` on each file lets us skip
 *      downloading anything we've already processed and that hasn't
 *      changed - critical once you have dozens of historical archive
 *      files that will never change again after the day they're created.
 *   2. Files that DO need downloading happen with limited concurrency
 *      instead of one at a time.
 *
 * Protected by a shared secret so random internet traffic can't trigger
 * (and bill) your ingestion - pass it as ?secret=... or an
 * Authorization: Bearer ... header.
 */

import { NextRequest, NextResponse } from "next/server";
import { listTlogFiles, downloadFile, DriveFileRef } from "@/lib/driveClient";
import { parseTlog } from "@/lib/tlogParser";
import {
  initSchema,
  fileHash,
  getKnownModifiedTime,
  ingestTransactions,
  markFileProcessed,
} from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel's own limit - separate from cron-job.org's 30s

// How many files to actually download+process in one run, and how many
// of those to do at once. Kept conservative so a real run - even one
// catching up a backlog - finishes well under cron-job.org's 30s cutoff.
const MAX_FILES_PER_RUN = 15;
const CONCURRENCY = 5;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.INGEST_SECRET;
  if (!expected) return false; // fail closed if not configured
  const header = req.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
  const param = req.nextUrl.searchParams.get("secret");
  return param === expected;
}

interface ProcessResult {
  file: string;
  skipped?: boolean;
  error?: string;
  transactions_in_file?: number;
  new?: number;
}

async function processOneFile(file: DriveFileRef): Promise<ProcessResult> {
  let raw: Buffer;
  try {
    raw = await downloadFile(file.id);
  } catch (err: any) {
    return { file: file.name, error: `download failed: ${err.message}` };
  }

  let txns;
  try {
    txns = parseTlog(raw, file.name);
  } catch (err: any) {
    return { file: file.name, error: `parse failed: ${err.message}` };
  }

  const newCount = await ingestTransactions(txns);
  await markFileProcessed(file.name, fileHash(raw), txns.length, file.modifiedTime);

  return { file: file.name, transactions_in_file: txns.length, new: newCount };
}

/** Runs `items` through `worker` with at most `limit` in flight at once. */
async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await initSchema();

  let files: DriveFileRef[];
  try {
    files = await listTlogFiles();
  } catch (err: any) {
    return NextResponse.json({ error: `Drive list failed: ${err.message}` }, { status: 500 });
  }

  // Cheap pass: for every file, compare Drive's modifiedTime against what
  // we last recorded - no downloading required for this check at all.
  const candidates: DriveFileRef[] = [];
  let skippedCount = 0;
  for (const file of files) {
    const knownMtime = await getKnownModifiedTime(file.name);
    if (knownMtime === file.modifiedTime) {
      skippedCount++;
      continue;
    }
    candidates.push(file);
  }

  // current.1/current.2 hold TODAY's live data and must never get
  // starved out by a large backlog of historical archive files (which
  // matters especially right after deploying a change like this one,
  // where hundreds of already-ingested files all look "changed" for one
  // run just because they're being seen for the first time since this
  // metadata was added - without this, that one-time backfill could
  // block live updates for hours).
  const isCurrentFile = (name: string) => name === "current.1.xml.gz" || name === "current.2.xml.gz";
  candidates.sort((a, b) => Number(isCurrentFile(b.name)) - Number(isCurrentFile(a.name)));

  const toProcess = candidates.slice(0, MAX_FILES_PER_RUN);
  const results = await runWithConcurrency(toProcess, CONCURRENCY, processOneFile);

  const filesChanged = results.filter((r) => !r.error).length;
  const newTxnTotal = results.reduce((sum, r) => sum + (r.new ?? 0), 0);

  return NextResponse.json({
    ok: true,
    files_seen: files.length,
    files_skipped_unchanged: skippedCount,
    files_changed: filesChanged,
    new_transactions: newTxnTotal,
    remaining_backlog: candidates.length > toProcess.length,
    details: results,
  });
}

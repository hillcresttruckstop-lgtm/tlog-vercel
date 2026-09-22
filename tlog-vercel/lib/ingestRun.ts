/**
 * ingestRun.ts
 * =============
 * The actual "check Drive, download what's new, parse, store" logic -
 * factored out of /api/ingest so it can be reused by /api/sync (the
 * button on the dashboard itself) without duplicating it. Both routes
 * get the exact same tested behavior: mtime-based skip, current.1/2
 * priority, and concurrency-limited downloads.
 */

import { listTlogFiles, downloadFile, DriveFileRef } from "./driveClient";
import { parseTlog } from "./tlogParser";
import {
  initSchema,
  fileHash,
  getKnownModifiedTime,
  ingestTransactions,
  ingestVoidEvents,
  markFileProcessed,
} from "./db";

// How many files to actually download+process in one run, and how many
// of those to do at once. Kept conservative so a real run - even one
// catching up a backlog - finishes well under cron-job.org's 30s cutoff.
const MAX_FILES_PER_RUN = 15;
const CONCURRENCY = 5;

interface ProcessResult {
  file: string;
  skipped?: boolean;
  error?: string;
  transactions_in_file?: number;
  new?: number;
}

export interface IngestRunResult {
  ok: true;
  files_seen: number;
  files_skipped_unchanged: number;
  files_changed: number;
  new_transactions: number;
  remaining_backlog: boolean;
  details: ProcessResult[];
}

async function processOneFile(file: DriveFileRef): Promise<ProcessResult> {
  let raw: Buffer;
  try {
    raw = await downloadFile(file.id);
  } catch (err: any) {
    return { file: file.name, error: `download failed: ${err.message}` };
  }

  let parsed;
  try {
    parsed = parseTlog(raw, file.name);
  } catch (err: any) {
    return { file: file.name, error: `parse failed: ${err.message}` };
  }

  const newCount = await ingestTransactions(parsed.transactions);
  await ingestVoidEvents(parsed.voidEvents);
  await markFileProcessed(file.name, fileHash(raw), parsed.transactions.length, file.modifiedTime);

  return { file: file.name, transactions_in_file: parsed.transactions.length, new: newCount };
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

export async function runIngest(): Promise<IngestRunResult> {
  await initSchema();

  const files = await listTlogFiles();

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
  // starved out by a large backlog of historical archive files.
  const isCurrentFile = (name: string) => name === "current.1.xml.gz" || name === "current.2.xml.gz";
  candidates.sort((a, b) => Number(isCurrentFile(b.name)) - Number(isCurrentFile(a.name)));

  const toProcess = candidates.slice(0, MAX_FILES_PER_RUN);
  const results = await runWithConcurrency(toProcess, CONCURRENCY, processOneFile);

  const filesChanged = results.filter((r) => !r.error).length;
  const newTxnTotal = results.reduce((sum, r) => sum + (r.new ?? 0), 0);

  return {
    ok: true,
    files_seen: files.length,
    files_skipped_unchanged: skippedCount,
    files_changed: filesChanged,
    new_transactions: newTxnTotal,
    remaining_backlog: candidates.length > toProcess.length,
    details: results,
  };
}

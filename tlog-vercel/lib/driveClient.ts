/**
 * driveClient.ts
 * ===============
 * Reads TLog .xml.gz files from Google Drive via the Drive API, using a
 * service account - the same auth pattern as your Report Navigator
 * script's Sheets integration, just with Drive's read-only scope instead.
 *
 * Setup required (see README): create/reuse a Google Cloud service
 * account, download its JSON key, share the "AB123" Drive folder with
 * the service account's email (Viewer access is enough), and put the
 * folder's ID + the service account's credentials into Vercel's
 * environment variables.
 */

import { google } from "googleapis";

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY are not set (add them in Vercel project settings)."
    );
  }
  return new google.auth.JWT({
    email,
    // Vercel env vars store literal \n, not real newlines - convert back.
    key: key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

export interface DriveFileRef {
  id: string;
  name: string;
  modifiedTime: string;
}

export async function listTlogFiles(): Promise<DriveFileRef[]> {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    throw new Error("GOOGLE_DRIVE_FOLDER_ID is not set (add it in Vercel project settings).");
  }
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const files: DriveFileRef[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and name contains '.xml.gz' and trashed = false`,
      fields: "nextPageToken, files(id, name, modifiedTime)",
      pageSize: 200,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name && f.modifiedTime) {
        files.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

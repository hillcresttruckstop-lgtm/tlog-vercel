# Hillcrest Truck Stop — Live Dashboard (Vercel version)

This is the online version of the local dashboard: same live transaction
feed, same fuel/payment/pump/merch breakdowns, same hour/day/month/year
views — but hosted on Vercel so you can open it from any device, not just
the PC it runs on.

**What changed from the local version, and why:**
- **Next.js (React)** instead of Flask — the standard modern stack for Vercel.
- **Neon Postgres** instead of a local SQLite file — Vercel's serverless
  functions don't have a persistent disk to keep a database file on.
- **Google Drive API** instead of reading `G:\My Drive\...` directly — a
  cloud server has no access to your PC's local filesystem, synced or not.
- **A free external scheduler** triggers data updates every ~15 minutes,
  instead of a background thread — Vercel's free plan only allows
  once-a-day built-in cron, so an outside trigger is what gets you closer
  to real-time on the free tier.
- **A real login screen** — the whole dashboard now sits behind a
  username/password you set yourself. Nobody can see your store's data
  without logging in first, from anywhere in the world, on any device.

The parser and every dashboard calculation were ported line-for-line from
the already-tested local version, and re-verified against your real
`current.1.xml.gz` / `current.2.xml.gz` files (identical transaction
counts and revenue totals as the local version) before being handed to you.

## Setup — five parts

### 1. Google Drive access (service account)

If you already set up a Google Cloud service account for the Report
Navigator → Sheets script, you can reuse the same one — just add Drive
access below. Otherwise:

1. Go to https://console.cloud.google.com/, create a project (or reuse
   your existing one).
2. APIs & Services → Library → enable **Google Drive API**.
3. APIs & Services → Credentials → Create Credentials → Service Account.
4. Open the service account → Keys → Add Key → Create new key → JSON.
   This downloads a `.json` file — keep it somewhere safe, you'll need
   two values from it in step 4 below.
5. In Google Drive, right-click your **AB123** folder (inside "Verifone
   TLogs") → Share → paste the service account's email (looks like
   `something@your-project.iam.gserviceaccount.com`, found in the JSON
   file's `client_email` field) → give it **Viewer** access.
6. Open the AB123 folder in your browser and copy its ID from the URL:
   `https://drive.google.com/drive/folders/<THIS PART IS THE ID>`

### 2. Database (Neon Postgres, free)

1. Create a Vercel account if you don't have one: https://vercel.com/signup
2. In your Vercel project (after step 3 below creates it) → Storage tab →
   Create Database → choose **Neon** (Postgres) → follow the prompts,
   free tier is enough for this. Vercel automatically sets `DATABASE_URL`
   for you — you don't need to copy/paste a connection string yourself.

### 3. Deploy to Vercel

Easiest path — no local Node setup needed on your end:
1. Push this project's code to a new GitHub repository (or ask me to help
   with that part if you're not familiar with git).
2. Go to https://vercel.com/new, import that repository, and click Deploy.
3. Come back and do step 2 (add the Neon database) from your new
   project's Storage tab.

### 4. Environment variables

In your Vercel project → Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from your service account JSON |
| `GOOGLE_PRIVATE_KEY` | `private_key` from that JSON (paste exactly, including `\n`) |
| `GOOGLE_DRIVE_FOLDER_ID` | the AB123 folder ID from step 1.6 |
| `INGEST_SECRET` | any random string you make up — protects the data-refresh endpoint from strangers |
| `AUTH_USERNAME` | whatever username you want to log in with |
| `AUTH_PASSWORD` | whatever password you want to log in with |
| `SESSION_SECRET` | a second, *different* random string — signs the login session. Generate one with `openssl rand -hex 32`, or any password generator |

`DATABASE_URL` is already set automatically by the Neon integration from
step 2. After adding these, redeploy (Vercel → Deployments → ⋯ → Redeploy)
so the new variables take effect.

### 5. Set up the free 15-minute refresh trigger

Your app's `/api/ingest` endpoint does the actual work of checking Drive
for new files — it just needs something to call it on a schedule. Using
[cron-job.org](https://cron-job.org) (free, no code):

1. Create a free account.
2. Create a new cron job:
   - **URL**: `https://YOUR-APP.vercel.app/api/ingest?secret=YOUR_INGEST_SECRET`
     (use the real values — your Vercel deployment URL and the
     `INGEST_SECRET` you set in step 4)
   - **Schedule**: every 15 minutes
3. Save. cron-job.org will now hit that URL every 15 minutes, which
   triggers the Drive check → parse → store cycle.

That's it — open `https://YOUR-APP.vercel.app` and you have the same live
dashboard, now reachable from anywhere.

## First run — backfilling history

The first time `/api/ingest` runs, it'll also pick up your dated archive
files (`2026-09-15.477.2.xml.gz` and so on) already sitting in Drive, not
just the two "current" files — that's what gives Year-to-Date and
Trailing Year real data instead of starting empty. If you have a large
number of archived files, the very first run processes up to 20 files per
call and picks up the rest on the following few 15-minute cycles — you'll
see `remaining_backlog: true` in the ingest response until it's fully
caught up (open `/api/ingest?secret=...` directly in your browser to
check its status any time).

## Project structure

```
app/
├── page.tsx                  Renders the dashboard
├── layout.tsx                 Fonts + page metadata
├── globals.css                 Dark theme, same design as the local version
├── login/page.tsx               Login screen
└── api/
    ├── ingest/route.ts          Called by cron-job.org every 15 min
    ├── summary/route.ts          KPIs + charts for the selected range
    ├── live-feed/route.ts         Recent transactions
    ├── status/route.ts             Ingestion status
    ├── login/route.ts               Checks username/password, sets session cookie
    └── logout/route.ts               Clears session cookie
proxy.ts                       Gates every page/API behind login (except /login and /api/ingest)
lib/
├── tlogParser.ts               VeriFone TLog XML parser (ported from Python)
├── db.ts                        Neon Postgres schema + queries
├── driveClient.ts                 Google Drive API access
└── auth.ts                         Login session signing/verification
components/
└── Dashboard.tsx                 All the client-side UI + charts
```

## Local development (optional)

If you want to test changes on your own machine before deploying:
```
npm install
cp .env.example .env.local   # fill in the values from steps 1-2 above
npm run dev
```
Then open http://localhost:3000.

## If something looks off

- **"waiting for first TLog file to be ingested…"** forever: open
  `/api/ingest?secret=YOUR_SECRET` directly in your browser — it returns
  JSON describing exactly what went wrong (bad Drive credentials, folder
  not shared, wrong folder ID, etc.) instead of failing silently.
- **cron-job.org shows failed runs**: check the response body it logged —
  a `401` means the secret in the URL doesn't match `INGEST_SECRET` in
  Vercel; a `500` will include a specific error message about Drive or
  the database.
- **Large backlog taking a while to fully load**: expected on first run,
  see "First run — backfilling history" above — it catches up over a few
  cycles automatically, no action needed.
- **Can't log in**: double check `AUTH_USERNAME` / `AUTH_PASSWORD` are
  set in Vercel exactly as you'd expect (no extra spaces), and that you
  redeployed after adding them — env var changes only take effect on the
  next deploy.
- **Why isn't `/api/ingest` behind the login too?** It's called by
  cron-job.org, not by you sitting logged in at a browser, so it can't
  use the session cookie — it's protected by its own separate
  `INGEST_SECRET` instead. Keep that secret private the same way you'd
  keep a password private.

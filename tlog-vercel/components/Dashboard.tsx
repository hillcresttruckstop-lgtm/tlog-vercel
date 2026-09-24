"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  ArcElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar, Doughnut } from "react-chartjs-2";

ChartJS.register(BarElement, CategoryScale, LinearScale, ArcElement, Tooltip, Legend);

const REFRESH_MS = 20000;
const RANGES = [
  { key: "today", label: "Today" },
  { key: "24h", label: "Last 24h" },
  { key: "7d", label: "7 Days" },
  { key: "30d", label: "30 Days" },
  { key: "ytd", label: "Year to Date" },
  { key: "year", label: "Trailing Year" },
];
const PALETTE = ["#E8A33D", "#4FD1C5", "#D6924F", "#E2637A", "#6FA8DC", "#D9B24C", "#7FBF7F", "#C97BAE"];

const fmtMoney = (n: number) =>
  `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtNum = (n: number, digits = 0) =>
  (n || 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

const chartBaseOptions = {
  responsive: true,
  color: "#8496B0",
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { display: false }, ticks: { color: "#8496B0" } },
    y: { grid: { color: "#1F2E48" }, ticks: { color: "#8496B0" } },
  },
};

function bucketLabel(bucket: string, granularity: string) {
  const d = new Date(bucket.length <= 7 ? bucket + "-01" : bucket.replace(" ", "T"));
  if (granularity === "hour") return d.toLocaleTimeString([], { hour: "numeric" });
  if (granularity === "day") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (granularity === "month") return d.toLocaleDateString([], { month: "short", year: "2-digit" });
  return bucket;
}

/** Turns an array of flat objects into a downloadable CSV file. */
function downloadCSV(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface FeedLine {
  description: string | null;
  category: string | null;
  dept_number: string | null;
  qty: number | null;
  unit_price: number | null;
  is_fuel: boolean;
  fuel_grade: string | null;
  fuel_volume: number | null;
  pump_number: number | null;
  line_total: number | null;
}
interface FeedPayment {
  tender_type: string;
  amount: number;
}
interface FeedItem {
  unique_id: string;
  trans_type: string;
  pos_num: number | null;
  tr_seq: string | null;
  date: string;
  cashier: string | null;
  total_with_tax: number;
  lines: FeedLine[];
  payments: FeedPayment[];
}

function feedDescription(item: FeedItem) {
  const fuelLine = item.lines.find((l) => l.is_fuel);
  if (fuelLine) {
    const pump = fuelLine.pump_number ? ` · Pump ${fuelLine.pump_number}` : "";
    return { chip: "fuel", label: `${fuelLine.fuel_grade || "Fuel"}${pump}` };
  }
  const first = item.lines[0];
  const extra = item.lines.length > 1 ? ` +${item.lines.length - 1} more` : "";
  return { chip: "merch", label: (first ? first.description : "Sale") + extra };
}

function feedSearchText(item: FeedItem) {
  return [
    item.cashier,
    item.trans_type,
    item.total_with_tax != null ? item.total_with_tax.toFixed(2) : null,
    ...item.lines.map((l) => l.description),
    ...item.lines.map((l) => l.category),
    ...item.lines.map((l) => l.fuel_grade),
    ...item.lines.map((l) => (l.pump_number ? `pump ${l.pump_number}` : null)),
    ...item.payments.map((p) => p.tender_type),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function feedType(item: FeedItem): "fuel" | "merch" {
  return item.lines.some((l) => l.is_fuel) ? "fuel" : "merch";
}

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const rounded = Math.round(pct * 10) / 10;
  const cls = rounded > 0.5 ? "up" : rounded < -0.5 ? "down" : "flat";
  const arrow = rounded > 0.5 ? "▲" : rounded < -0.5 ? "▼" : "–";
  return (
    <div className={`kpi-delta ${cls}`}>
      {arrow} {Math.abs(rounded)}% vs prev. period
    </div>
  );
}

function hourLabel(hour: number) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? "a" : "p"}`;
}

function VoidsPanel({
  range,
  customStart,
  customEnd,
  onSelectTxn,
}: {
  range: string;
  customStart: string;
  customEnd: string;
  onSelectTxn: (item: any) => void;
}) {
  const [data, setData] = useState<{ tickets: any[]; lines: any[] } | null>(null);
  const [tab, setTab] = useState<"tickets" | "lines">("tickets");

  useEffect(() => {
    const rangeQuery = range === "custom" ? `range=custom&start=${customStart}&end=${customEnd}` : `range=${range}`;
    fetch(`/api/voids?${rangeQuery}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ tickets: [], lines: [] }));
  }, [range, customStart, customEnd]);

  return (
    <section className="panel voids-panel">
      <div className="panel-head">
        <h2>Voids</h2>
        <div className="voids-tabs">
          <button className={tab === "tickets" ? "active" : ""} onClick={() => setTab("tickets")}>
            Void Tickets {data ? `(${data.tickets.length})` : ""}
          </button>
          <button className={tab === "lines" ? "active" : ""} onClick={() => setTab("lines")}>
            Void Lines {data ? `(${data.lines.length})` : ""}
          </button>
        </div>
      </div>

      {!data ? (
        <div className="empty-note">Loading…</div>
      ) : tab === "tickets" ? (
        data.tickets.length ? (
          <div className="table-scroll">
            <table className="sortable-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Register</th>
                  <th>Cashier</th>
                  <th>Items</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {data.tickets.map((t) => {
                  const openTicket = () =>
                    onSelectTxn({
                      unique_id: t.unique_id,
                      trans_type: "void",
                      pos_num: t.pos_num,
                      tr_seq: t.tr_seq,
                      date: t.date,
                      cashier: t.cashier,
                      total_with_tax: t.total_with_tax,
                      lines: t.lines ?? [],
                      payments: [],
                    });
                  return (
                    <tr
                      key={t.unique_id}
                      onClick={openTicket}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openTicket();
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{new Date(t.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td>
                      <td>{t.pos_num != null ? `Reg ${t.pos_num}` : "—"}</td>
                      <td>{t.cashier ?? "—"}</td>
                      <td>{(t.lines ?? []).length}</td>
                      <td>{fmtMoney(t.total_with_tax)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-note">No fully-voided tickets in this range.</div>
        )
      ) : data.lines.length ? (
        <div className="table-scroll">
          <table className="sortable-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Item</th>
                <th>Category</th>
                <th>Ticket #</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l, i) => (
                <tr key={i}>
                  <td>{new Date(l.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td>
                  <td>{l.description ?? "—"}</td>
                  <td>{l.category ?? "—"}</td>
                  <td>{l.tr_seq ?? "—"}</td>
                  <td>{fmtMoney(l.line_total ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-note">No individually-voided line items in this range.</div>
      )}
    </section>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState("today");
  const todayStr = new Date().toISOString().slice(0, 10);
  const [customStart, setCustomStart] = useState(todayStr);
  const [customEnd, setCustomEnd] = useState(todayStr);
  const [summary, setSummary] = useState<any>(null);
  const [insights, setInsights] = useState<any>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [selectedTxn, setSelectedTxn] = useState<FeedItem | null>(null);
  const [voidsOpen, setVoidsOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_MS / 1000);
  const [ledgerSort, setLedgerSort] = useState<{ col: string; dir: "asc" | "desc" }>({
    col: "day",
    dir: "desc",
  });
  const [merchSort, setMerchSort] = useState<{ col: string; dir: "asc" | "desc" }>({
    col: "revenue",
    dir: "desc",
  });
  const [merchCategoryFilter, setMerchCategoryFilter] = useState("all");
  const knownIds = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);
  // FIXED: switching ranges quickly (e.g. Today -> 7 Days) fires a new
  // fetch for each, but nothing stopped an OLDER, slower request from
  // resolving AFTER a newer one and overwriting its results - the
  // dashboard could briefly show data for a range you'd already clicked
  // away from, and it wouldn't self-correct until the next poll cycle.
  // This counter tags every refresh() call; a response is only applied if
  // it's still the most recently issued one by the time it comes back.
  const latestRequestId = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++latestRequestId.current;
    try {
      const rangeQuery =
        range === "custom" ? `range=custom&start=${customStart}&end=${customEnd}` : `range=${range}`;
      const [summaryRes, insightsRes, feedRes, statusRes] = await Promise.all([
        fetch(`/api/summary?${rangeQuery}`).then((r) => r.json()),
        fetch(`/api/insights?${rangeQuery}`).then((r) => r.json()),
        fetch(`/api/live-feed?limit=60`).then((r) => r.json()),
        fetch(`/api/status`).then((r) => r.json()),
      ]);
      if (requestId !== latestRequestId.current) return; // a newer request already landed - discard this one
      setSummary(summaryRes);
      setInsights(insightsRes);
      setFeed(feedRes);
      setStatus(statusRes);
      setError(null);
      setSecondsLeft(REFRESH_MS / 1000);
    } catch {
      if (requestId !== latestRequestId.current) return;
      setError("connection error — retrying…");
    }
  }, [range, customStart, customEnd]);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSyncResult(`Sync failed: ${data.error || "unknown error"}`);
      } else {
        setSyncResult(
          data.new_transactions > 0
            ? `Synced — ${data.new_transactions} new transaction${data.new_transactions === 1 ? "" : "s"}`
            : "Synced — up to date, nothing new"
        );
        await refresh();
      }
    } catch {
      setSyncResult("Sync failed — connection error");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 5000);
    }
  }

  async function handleReset() {
    setResetting(true);
    setSyncResult("Resetting…");
    try {
      const resetRes = await fetch("/api/admin/reset-ui", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      });
      const resetData = await resetRes.json();
      if (!resetRes.ok || resetData.error) {
        setSyncResult(`Reset failed: ${resetData.error || "unknown error"}`);
        return;
      }

      // Reset itself is done (fast - just DELETE statements). The
      // re-ingest is a SEPARATE follow-up request now, not bundled into
      // the same one - ingest alone can take 30+ seconds right after a
      // full wipe (the most work it will ever have to do), and stacking
      // both into one request risked exceeding Vercel's 60s function
      // limit, which silently killed the operation mid-ingest. Splitting
      // them keeps each request comfortably inside its own budget.
      setSyncResult("Reset done — syncing fresh data…");
      const syncRes = await fetch("/api/sync", { method: "POST" });
      const syncData = await syncRes.json();
      if (!syncRes.ok || syncData.error) {
        setSyncResult(`Reset succeeded, but the follow-up sync failed: ${syncData.error || "unknown error"} — try clicking Sync manually.`);
      } else {
        const newTxns = syncData.new_transactions ?? 0;
        setSyncResult(
          `Reset complete — ${newTxns} transaction${newTxns === 1 ? "" : "s"} synced so far` +
            (syncData.remaining_backlog ? " (more historical data still catching up - click Sync again anytime)" : "")
        );
      }
      await refresh();
    } catch {
      setSyncResult("Reset failed — connection error");
    } finally {
      setResetting(false);
      setResetModalOpen(false);
      setResetConfirmText("");
      setTimeout(() => setSyncResult(null), 10000);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Visible "time until next refresh" bar - small touch, but it's what
  // makes a page genuinely feel alive instead of just "static until it
  // isn't."
  useEffect(() => {
    const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const newIds = new Set(feed.map((f) => f.unique_id));
    knownIds.current = newIds;
    firstLoad.current = false;
  }, [feed]);

  const kpis = summary?.kpis;
  const avgTicket = kpis?.txn_count ? kpis.revenue / kpis.txn_count : 0;

  const filteredFeed = useMemo(() => {
    let rows = feed;
    if (typeFilter !== "all") rows = rows.filter((item) => feedType(item) === typeFilter);
    if (paymentFilter !== "all") {
      rows = rows.filter((item) => item.payments.some((p) => p.tender_type === paymentFilter));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((item) => feedSearchText(item).includes(q));
    }
    return rows;
  }, [feed, search, typeFilter, paymentFilter]);

  const paymentTypes = useMemo(() => {
    const set = new Set<string>();
    for (const item of feed) for (const p of item.payments) if (p.tender_type !== "Change") set.add(p.tender_type);
    return Array.from(set).sort();
  }, [feed]);

  const sortedLedger = useMemo(() => {
    const rows: any[] = insights?.daily_ledger ?? [];
    const { col, dir } = ledgerSort;
    const sorted = [...rows].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (typeof av === "string") return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return dir === "asc" ? av - bv : bv - av;
    });
    return sorted;
  }, [insights, ledgerSort]);

  function toggleSort(col: string) {
    setLedgerSort((prev) =>
      prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" }
    );
  }

  const merchCategories = useMemo(() => {
    const set = new Set<string>();
    for (const row of summary?.merch ?? []) if (row.category) set.add(row.category);
    return Array.from(set).sort();
  }, [summary]);

  const sortedMerch = useMemo(() => {
    let rows: any[] = summary?.merch ?? [];
    if (merchCategoryFilter !== "all") rows = rows.filter((r) => r.category === merchCategoryFilter);
    const { col, dir } = merchSort;
    return [...rows].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (typeof av === "string") return dir === "asc" ? (av ?? "").localeCompare(bv ?? "") : (bv ?? "").localeCompare(av ?? "");
      return dir === "asc" ? (av ?? 0) - (bv ?? 0) : (bv ?? 0) - (av ?? 0);
    });
  }, [summary, merchSort, merchCategoryFilter]);

  function toggleMerchSort(col: string) {
    setMerchSort((prev) =>
      prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "item" ? "asc" : "desc" }
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <img src="/mascot.png" alt="" />
          </span>
          <div>
            <div className="brand-name">Hillcrest Truck Stop</div>
            <div className="brand-sub">Live pump &amp; register feed</div>
          </div>
        </div>
        <div className="status">
          <span>
            {error
              ? error
              : status
              ? status.total_transactions > 0
                ? `${status.total_transactions.toLocaleString()} txns tracked${
                    status.last_transaction_date
                      ? " · last sale " + new Date(status.last_transaction_date).toLocaleTimeString()
                      : ""
                  }`
                : "waiting for first TLog file to be ingested…"
              : "connecting…"}
          </span>
          <span className="refresh-track" title={`Refreshing in ${secondsLeft}s`}>
            <span
              className="refresh-fill"
              style={{ width: `${(secondsLeft / (REFRESH_MS / 1000)) * 100}%` }}
            />
          </span>
          <span className={`pulse-dot ${status?.total_transactions > 0 ? "live" : ""}`} />
          {syncResult && (
            <span style={{ fontSize: 11, color: syncResult.includes("failed") ? "var(--rose)" : "var(--up)" }}>
              {syncResult}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="header-btn"
            style={{ color: syncing ? "var(--text-faint)" : "var(--amber)", cursor: syncing ? "default" : "pointer" }}
          >
            {syncing ? "Syncing…" : "↻ Sync"}
          </button>
          <button
            onClick={() => setResetModalOpen(true)}
            className="header-btn header-btn-danger"
            title="Wipes all stored data and rebuilds it from scratch through the current parser - only needed after a parsing-logic update"
          >
            ⚠ Reset & Rebuild
          </button>
          <button
            onClick={async () => {
              await fetch("/api/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            className="header-btn"
          >
            Sign out
          </button>
        </div>
      </header>

      {resetModalOpen && (
        <div className="txn-modal-backdrop" onClick={() => !resetting && setResetModalOpen(false)}>
          <div className="reset-modal" onClick={(e) => e.stopPropagation()}>
            <div className="reset-modal-title">⚠ Reset & Rebuild everything?</div>
            <p className="reset-modal-body">
              This permanently deletes <b>every</b> stored transaction, line item, payment, and void
              ticket, then immediately re-pulls and re-parses everything from Google Drive through the
              current parser. Today's live data reappears right away; historical months take longer to
              fully catch back up. This only needs to be run after a parsing-logic update — not for
              routine use (that's what the Sync button is for).
            </p>
            <p className="reset-modal-body">
              Type <b>RESET</b> below to confirm:
            </p>
            <input
              className="reset-modal-input"
              value={resetConfirmText}
              onChange={(e) => setResetConfirmText(e.target.value)}
              placeholder="Type RESET"
              disabled={resetting}
              autoFocus
            />
            <div className="reset-modal-actions">
              <button
                className="header-btn"
                onClick={() => setResetModalOpen(false)}
                disabled={resetting}
              >
                Cancel
              </button>
              <button
                className="header-btn-danger-solid"
                onClick={handleReset}
                disabled={resetConfirmText !== "RESET" || resetting}
              >
                {resetting ? "Resetting & rebuilding…" : "Permanently reset & rebuild"}
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="range-tabs">
        {RANGES.map((r) => (
          <button key={r.key} className={r.key === range ? "active" : ""} onClick={() => setRange(r.key)}>
            {r.label}
          </button>
        ))}
        <button className={range === "custom" ? "active" : ""} onClick={() => setRange("custom")}>
          Custom
        </button>
        {range === "custom" && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 6 }}>
            <input
              type="date"
              value={customStart}
              max={customEnd}
              onChange={(e) => setCustomStart(e.target.value)}
              className="feed-search"
              style={{ marginBottom: 0, width: "auto", padding: "6px 8px" }}
            />
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>to</span>
            <input
              type="date"
              value={customEnd}
              min={customStart}
              max={todayStr}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="feed-search"
              style={{ marginBottom: 0, width: "auto", padding: "6px 8px" }}
            />
            <button onClick={refresh} style={{ padding: "7px 14px" }}>
              Apply
            </button>
          </span>
        )}
      </nav>

      <main>
        <section className="kpi-row">
          <div className="kpi" style={{ ["--accent" as any]: "var(--amber)" }}>
            <div className="kpi-label">Revenue</div>
            <div className="kpi-value mono">{kpis ? fmtMoney(kpis.revenue) : "—"}</div>
            <DeltaBadge pct={insights?.comparison?.revenue_change_pct ?? null} />
          </div>
          <div className="kpi" style={{ ["--accent" as any]: "var(--cyan)" }}>
            <div className="kpi-label">Fuel Gallons</div>
            <div className="kpi-value mono">{kpis ? fmtNum(kpis.fuel_gallons, 1) : "—"}</div>
            <DeltaBadge pct={insights?.comparison?.fuel_gallons_change_pct ?? null} />
          </div>
          <div className="kpi" style={{ ["--accent" as any]: "var(--tan)" }}>
            <div className="kpi-label">Transactions</div>
            <div className="kpi-value mono">{kpis ? fmtNum(kpis.txn_count) : "—"}</div>
            <DeltaBadge pct={insights?.comparison?.txn_count_change_pct ?? null} />
          </div>
          <div className="kpi" style={{ ["--accent" as any]: "var(--rose)" }}>
            <div className="kpi-label">Avg Ticket</div>
            <div className="kpi-value mono">{kpis ? fmtMoney(avgTicket) : "—"}</div>
          </div>
          <div className="kpi" style={{ ["--accent" as any]: "var(--cyan)" }}>
            <div className="kpi-label">Tax Collected</div>
            <div className="kpi-value mono">{kpis ? fmtMoney(kpis.tax_collected) : "—"}</div>
          </div>
          <div
            className="kpi kpi-clickable"
            style={{ ["--accent" as any]: "var(--rose)" }}
            onClick={() => setVoidsOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setVoidsOpen((v) => !v);
              }
            }}
            role="button"
            tabIndex={0}
            aria-expanded={voidsOpen}
          >
            <div className="kpi-label">Voids {voidsOpen ? "▲" : "▾"}</div>
            <div className="kpi-value mono">{kpis ? fmtNum(kpis.void_count ?? 0) : "—"}</div>
          </div>
        </section>

        {voidsOpen && <VoidsPanel range={range} customStart={customStart} customEnd={customEnd} onSelectTxn={setSelectedTxn} />}

        {kpis && kpis.revenue > 0 && (
          <section className="panel sales-mix">
            <div className="panel-head">
              <h2>Inside vs. outside sales</h2>
              <span className="panel-sub">inside = merchandise (ex-lottery), outside = fuel at the pump</span>
            </div>
            <div className="sales-mix-bar">
              <div
                className="sales-mix-segment outside"
                style={{ width: `${(kpis.fuel_revenue / kpis.revenue) * 100}%` }}
                title={`Outside (fuel): ${fmtMoney(kpis.fuel_revenue)}`}
              />
              <div
                className="sales-mix-segment inside"
                style={{ width: `${(kpis.merch_revenue / kpis.revenue) * 100}%` }}
                title={`Inside (merch, all): ${fmtMoney(kpis.merch_revenue)}`}
              />
            </div>
            <div className="sales-mix-legend">
              <div className="sales-mix-stat">
                <span className="sales-mix-dot outside" />
                <div>
                  <div className="sales-mix-label">Outside sale (fuel)</div>
                  <div className="sales-mix-value mono">
                    {fmtMoney(kpis.fuel_revenue)}
                    <span className="sales-mix-pct"> · {((kpis.fuel_revenue / kpis.revenue) * 100).toFixed(1)}%</span>
                  </div>
                </div>
              </div>
              <div className="sales-mix-stat">
                <span className="sales-mix-dot inside" />
                <div>
                  <div className="sales-mix-label">Inside sale (ex-lottery)</div>
                  <div className="sales-mix-value mono">
                    {fmtMoney(kpis.inside_sales_ex_lottery ?? kpis.merch_revenue)}
                    <span className="sales-mix-pct">
                      {" "}
                      · {(((kpis.inside_sales_ex_lottery ?? kpis.merch_revenue) / kpis.revenue) * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="sales-mix-sub">
                    All merch (incl. lottery): {fmtMoney(kpis.merch_revenue)}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {insights?.highlights?.busiest_hour && insights.highlights.busiest_hour.revenue > 0 && (
          <div className="highlights-bar">
            <span>
              Busiest hour: <strong>{hourLabel(insights.highlights.busiest_hour.hour)}</strong> (
              {fmtMoney(insights.highlights.busiest_hour.revenue)})
            </span>
            {insights.highlights.busiest_day && insights.highlights.busiest_day.revenue > 0 && (
              <span>
                Busiest day: <strong>{insights.highlights.busiest_day.label}</strong> (
                {fmtMoney(insights.highlights.busiest_day.revenue)})
              </span>
            )}
            {kpis?.avg_price_per_gallon != null && (
              <span>
                Avg price/gal: <strong>${kpis.avg_price_per_gallon.toFixed(3)}</strong>
              </span>
            )}
          </div>
        )}

        {insights?.pump_flags?.length > 0 && (
          <div className="pump-warning">
            ⚠ No fuel sales this range from: {insights.pump_flags.map((p: number) => `Pump ${p}`).join(", ")} —
            worth a quick check if that's unexpected.
          </div>
        )}

        <section className="main-grid">
          <div className="panel">
            <div className="panel-head">
              <h2>Revenue over time</h2>
              <span className="panel-sub">
                {summary ? new Date(summary.range.start).toLocaleString([], { dateStyle: "medium" }) + " – now" : ""}
              </span>
            </div>
            {summary?.timeseries?.length ? (
              <Bar
                data={{
                  labels: summary.timeseries.map((t: any) => bucketLabel(t.bucket, summary.range.granularity)),
                  datasets: [
                    {
                      label: "Revenue",
                      data: summary.timeseries.map((t: any) => t.revenue),
                      backgroundColor: "#E8A33D",
                      borderRadius: 3,
                      maxBarThickness: 34,
                    },
                  ],
                }}
                options={chartBaseOptions as any}
              />
            ) : (
              <div className="empty-note">No revenue data in this range yet.</div>
            )}
          </div>

          <div className="panel panel-feed">
            <div className="panel-head">
              <h2>Live transaction feed</h2>
              <span className="panel-sub">tap a row for details</span>
            </div>
            <input
              className="feed-search"
              placeholder="Search anything — item, grade, pump, cashier, amount, payment…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <select
                className="feed-filter-select"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                <option value="fuel">Fuel only</option>
                <option value="merch">Merchandise only</option>
              </select>
              <select
                className="feed-filter-select"
                value={paymentFilter}
                onChange={(e) => setPaymentFilter(e.target.value)}
              >
                <option value="all">All payment types</option>
                {paymentTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {(typeFilter !== "all" || paymentFilter !== "all" || search) && (
                <button
                  className="export-btn"
                  onClick={() => {
                    setTypeFilter("all");
                    setPaymentFilter("all");
                    setSearch("");
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="feed">
              {filteredFeed.length === 0 && (
                <div className="empty-note">{feed.length === 0 ? "No transactions yet." : "No matches."}</div>
              )}
              {filteredFeed.map((item) => {
                const { chip, label } = feedDescription(item);
                const isNew = !firstLoad.current && !knownIds.current.has(item.unique_id);
                const time = new Date(item.date).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                });
                return (
                  <div
                    key={item.unique_id}
                    className={`feed-row ${isNew ? "new" : ""}`}
                    onClick={() => setSelectedTxn(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedTxn(item);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="feed-row-main">
                      <div className="feed-left">
                        <div className="feed-desc">
                          <span className={`chip ${chip}`}>{chip}</span>
                          {label}
                        </div>
                        <div className="feed-time">
                          {time}
                          {item.cashier ? " · " + item.cashier : ""}
                        </div>
                      </div>
                      <div className="feed-amount">{fmtMoney(item.total_with_tax)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="tri-grid">
          <div className="panel">
            <div className="panel-head">
              <h2>Fuel by grade</h2>
              <button
                className="export-btn"
                onClick={() => downloadCSV(`fuel-by-grade-${range}.csv`, summary?.fuel_by_grade || [])}
              >
                Export CSV
              </button>
            </div>
            {summary?.fuel_by_grade?.length ? (
              <Bar
                data={{
                  labels: summary.fuel_by_grade.map((f: any) => f.grade),
                  datasets: [{ data: summary.fuel_by_grade.map((f: any) => f.revenue), backgroundColor: "#4FD1C5", borderRadius: 3 }],
                }}
                options={{ ...chartBaseOptions, indexAxis: "y" } as any}
              />
            ) : (
              <div className="empty-note">No fuel sales in this range yet.</div>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Payment mix</h2>
            </div>
            {summary?.payment_mix?.length ? (
              <Doughnut
                data={{
                  labels: summary.payment_mix.map((p: any) => p.tender),
                  datasets: [{ data: summary.payment_mix.map((p: any) => p.amount), backgroundColor: PALETTE, borderColor: "#111C30", borderWidth: 2 }],
                }}
                options={{ responsive: true, plugins: { legend: { position: "bottom", labels: { boxWidth: 10, padding: 12, color: "#8496B0" } } } } as any}
              />
            ) : (
              <div className="empty-note">No payments in this range yet.</div>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Pump activity</h2>
            </div>
            {summary?.pump_activity?.length ? (
              <Bar
                data={{
                  labels: summary.pump_activity.map((p: any) => "Pump " + p.pump),
                  datasets: [{ label: "Gallons", data: summary.pump_activity.map((p: any) => p.gallons), backgroundColor: "#D6924F", borderRadius: 3 }],
                }}
                options={chartBaseOptions as any}
              />
            ) : (
              <div className="empty-note">No pump activity in this range yet.</div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Merch sales by category</h2>
            <div className="panel-head-actions">
              <span className="panel-sub">
                {summary?.merch_by_category?.length
                  ? `Total: ${fmtMoney(summary.merch_by_category.reduce((s: number, c: any) => s + c.revenue, 0))}`
                  : ""}
              </span>
              <button
                className="export-btn"
                onClick={() => downloadCSV(`merch-by-category-${range}.csv`, summary?.merch_by_category || [])}
              >
                Export CSV
              </button>
            </div>
          </div>
          {summary?.merch_by_category?.length ? (
            <div className="category-grid">
              {summary.merch_by_category.map((c: any) => (
                <div className="category-card" key={c.category}>
                  <div className="category-name">{c.category}</div>
                  <div className="category-value mono">{fmtMoney(c.revenue)}</div>
                  <div className="category-count">{fmtNum(c.sale_count)} sale{c.sale_count === 1 ? "" : "s"}</div>
                </div>
              ))}
              {kpis && (
                <div className="category-card category-card-total">
                  <div className="category-name">Merch Sales</div>
                  <div className="category-value mono">{fmtMoney(kpis.merch_revenue)}</div>
                  <div className="category-count">
                    Inside: {fmtMoney(kpis.inside_sales_ex_lottery ?? kpis.merch_revenue)}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="empty-note">No merchandise sales in this range yet.</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Lottery</h2>
          </div>
          <div className="category-grid">
            <div className="category-card">
              <div className="category-name">Scratch Off</div>
              <div className="category-value mono lottery-color">{fmtMoney(summary?.lottery?.scratch_sales ?? 0)}</div>
            </div>
            <div className="category-card">
              <div className="category-name">Lottery</div>
              <div className="category-value mono lottery-color">{fmtMoney(summary?.lottery?.lottery_sales ?? 0)}</div>
            </div>
            <div className="category-card">
              <div className="category-name">Lottery PO</div>
              <div className="category-value mono lottery-negative">-{fmtMoney(summary?.lottery?.paid_out ?? 0)}</div>
            </div>
            <div className="category-card category-card-total">
              <div className="category-name">Net Lottery</div>
              <div className="category-value mono lottery-color">{fmtMoney(summary?.lottery?.net_lottery ?? 0)}</div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Gallons pumped — live</h2>
            <span className="panel-sub">by grade, current range</span>
          </div>
          {summary?.fuel_by_grade?.length ? (
            <div className="category-grid">
              {summary.fuel_by_grade.map((f: any) => (
                <div className="category-card" key={f.grade}>
                  <div className="category-name">{f.grade}</div>
                  <div className="category-value mono gallons">{fmtNum(f.gallons, 3)}</div>
                  <div className="category-count">
                    {fmtMoney(f.revenue)} · ${f.gallons > 0 ? (f.revenue / f.gallons).toFixed(3) : "0.000"}/gal
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-note">No fuel sales in this range yet.</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Top merchandise</h2>
            <div className="panel-head-actions">
              <select
                className="feed-filter-select"
                value={merchCategoryFilter}
                onChange={(e) => setMerchCategoryFilter(e.target.value)}
                style={{ flex: "none", width: "auto" }}
              >
                <option value="all">All categories</option>
                {merchCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button className="export-btn" onClick={() => downloadCSV(`top-merchandise-${range}.csv`, sortedMerch)}>
                Export CSV
              </button>
            </div>
          </div>
          <div className="table-scroll">
          <table className="sortable-table">
            <thead>
              <tr>
                {[
                  ["item", "Item"],
                  ["category", "Category"],
                  ["dept", "Dept"],
                  ["qty", "Qty sold"],
                  ["revenue", "Revenue"],
                ].map(([key, label]) => (
                  <th key={key} className={merchSort.col === key ? "sorted" : ""} onClick={() => toggleMerchSort(key)}>
                    {label} {merchSort.col === key ? (merchSort.dir === "asc" ? "↑" : "↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedMerch.length ? (
                sortedMerch.map((row: any, i: number) => (
                  <tr key={i}>
                    <td>{row.item ?? "—"}</td>
                    <td>{row.category ?? "—"}</td>
                    <td>{row.dept ?? "—"}</td>
                    <td>{fmtNum(row.qty, row.qty % 1 ? 2 : 0)}</td>
                    <td>{fmtMoney(row.revenue)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="empty-note">
                    No merchandise sales in this range yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </section>

        <section className="two-col-grid">
          <div className="panel">
            <div className="panel-head">
              <h2>Busiest hours</h2>
              <span className="panel-sub">all days in range, combined</span>
            </div>
            {insights?.hour_of_day?.some((h: any) => h.revenue > 0) ? (
              <Bar
                data={{
                  labels: insights.hour_of_day.map((h: any) => hourLabel(h.hour)),
                  datasets: [{ data: insights.hour_of_day.map((h: any) => h.revenue), backgroundColor: "#E8A33D", borderRadius: 3 }],
                }}
                options={chartBaseOptions as any}
              />
            ) : (
              <div className="empty-note">No data in this range yet.</div>
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>Busiest days of week</h2>
              <span className="panel-sub">all weeks in range, combined</span>
            </div>
            {insights?.day_of_week?.some((d: any) => d.revenue > 0) ? (
              <Bar
                data={{
                  labels: insights.day_of_week.map((d: any) => d.label),
                  datasets: [{ data: insights.day_of_week.map((d: any) => d.revenue), backgroundColor: "#9C8FE0", borderRadius: 3 }],
                }}
                options={chartBaseOptions as any}
              />
            ) : (
              <div className="empty-note">No data in this range yet.</div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Daily ledger</h2>
            <div className="panel-head-actions">
              <button
                className="export-btn"
                onClick={() => downloadCSV(`daily-ledger-${range}.csv`, sortedLedger)}
              >
                Export CSV
              </button>
              <button className="print-btn" onClick={() => window.print()}>
                Print report
              </button>
            </div>
          </div>
          <div className="table-scroll">
          <table className="sortable-table">
            <thead>
              <tr>
                {[
                  ["day", "Date"],
                  ["txn_count", "Transactions"],
                  ["revenue", "Revenue"],
                  ["fuel_gallons", "Fuel Gallons"],
                  ["fuel_revenue", "Fuel Revenue"],
                  ["tax_collected", "Tax Collected"],
                ].map(([key, label]) => (
                  <th
                    key={key}
                    className={ledgerSort.col === key ? "sorted" : ""}
                    onClick={() => toggleSort(key)}
                  >
                    {label} {ledgerSort.col === key ? (ledgerSort.dir === "asc" ? "↑" : "↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedLedger.length ? (
                sortedLedger.map((row: any) => (
                  <tr key={row.day}>
                    <td>{new Date(row.day + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</td>
                    <td>{fmtNum(row.txn_count)}</td>
                    <td>{fmtMoney(row.revenue)}</td>
                    <td>{fmtNum(row.fuel_gallons, 1)}</td>
                    <td>{fmtMoney(row.fuel_revenue)}</td>
                    <td>{fmtMoney(row.tax_collected)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="empty-note">
                    No days with activity in this range yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Repeat customers</h2>
            <span className="panel-sub">cards seen 2+ times in this range, by last 4 digits</span>
          </div>
          <div className="table-scroll">
          <table className="sortable-table">
            <thead>
              <tr>
                <th>Card ending in</th>
                <th>Visits</th>
                <th>Total spent</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {insights?.repeat_customers?.length ? (
                insights.repeat_customers.map((c: any) => (
                  <tr key={c.card_last4}>
                    <td>•••• {c.card_last4}</td>
                    <td>{fmtNum(c.visits)}</td>
                    <td>{fmtMoney(c.total_spent)}</td>
                    <td>{new Date(c.last_seen).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="empty-note">
                    No repeat customers detected in this range yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </section>
      </main>

      {selectedTxn && (
        <div className="txn-modal-backdrop" onClick={() => setSelectedTxn(null)}>
          <div className="txn-modal" onClick={(e) => e.stopPropagation()}>
            <div className="txn-modal-header">
              <div>
                <div className="txn-modal-title">
                  Transaction #{selectedTxn.tr_seq || selectedTxn.unique_id.slice(-7)}
                </div>
                <div className="txn-modal-date">
                  {new Date(selectedTxn.date).toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })}
                </div>
              </div>
              <button className="txn-modal-close" onClick={() => setSelectedTxn(null)} aria-label="Close">
                ×
              </button>
            </div>

            <div className="txn-modal-fields">
              <div className="txn-field">
                <span>Type</span>
                <span className={`chip ${feedType(selectedTxn)}`}>{feedType(selectedTxn)}</span>
              </div>
              {selectedTxn.pos_num != null && (
                <div className="txn-field">
                  <span>Register</span>
                  <span>Reg {selectedTxn.pos_num}</span>
                </div>
              )}
              {selectedTxn.cashier && (
                <div className="txn-field">
                  <span>Cashier</span>
                  <span>{selectedTxn.cashier}</span>
                </div>
              )}
              <div className="txn-field">
                <span>Tender</span>
                <span>{selectedTxn.payments.map((p) => p.tender_type).join(", ") || "—"}</span>
              </div>
              <div className="txn-field txn-field-total">
                <span>Charged Total</span>
                <span className="mono">{fmtMoney(selectedTxn.total_with_tax)}</span>
              </div>
            </div>

            <div className="txn-modal-lines">
              <div className="txn-lines-header">Line Items</div>
              <div className="table-scroll">
                <table className="sortable-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Dept</th>
                      <th>Qty</th>
                      <th>Price</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTxn.lines.map((l, i) => (
                      <tr key={i}>
                        <td>{l.is_fuel ? l.fuel_grade || l.description : l.description}</td>
                        <td>{l.is_fuel ? "FUEL" : l.category ?? l.dept_number ?? "—"}</td>
                        <td>{l.is_fuel ? fmtNum(l.fuel_volume ?? 0, 3) : fmtNum(l.qty ?? 0, (l.qty ?? 0) % 1 ? 2 : 0)}</td>
                        <td>{l.unit_price != null ? `$${l.unit_price.toFixed(3)}` : "—"}</td>
                        <td>{fmtMoney(l.line_total ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="txn-modal-footer">
                <span>Charged Total</span>
                <span className="mono">{fmtMoney(selectedTxn.total_with_tax)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

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
    ...item.lines.map((l) => l.description),
    ...item.lines.map((l) => l.fuel_grade),
    ...item.lines.map((l) => (l.pump_number ? `pump ${l.pump_number}` : null)),
    ...item.payments.map((p) => p.tender_type),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export default function Dashboard() {
  const [range, setRange] = useState("today");
  const [summary, setSummary] = useState<any>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_MS / 1000);
  const knownIds = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [summaryRes, feedRes, statusRes] = await Promise.all([
        fetch(`/api/summary?range=${range}`).then((r) => r.json()),
        fetch(`/api/live-feed?limit=60`).then((r) => r.json()),
        fetch(`/api/status`).then((r) => r.json()),
      ]);
      setSummary(summaryRes);
      setFeed(feedRes);
      setStatus(statusRes);
      setError(null);
      setSecondsLeft(REFRESH_MS / 1000);
    } catch {
      setError("connection error — retrying…");
    }
  }, [range]);

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
    if (!search.trim()) return feed;
    const q = search.trim().toLowerCase();
    return feed.filter((item) => feedSearchText(item).includes(q));
  }, [feed, search]);

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
          <span className="refresh-track" title={`Refreshing in ${secondsLeft}s`}>
            <span
              className="refresh-fill"
              style={{ width: `${(secondsLeft / (REFRESH_MS / 1000)) * 100}%` }}
            />
          </span>
          <span className={`pulse-dot ${status?.total_transactions > 0 ? "live" : ""}`} style={{ marginLeft: 10 }} />
          <button
            onClick={async () => {
              await fetch("/api/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            style={{
              marginLeft: 14,
              background: "transparent",
              border: "1px solid var(--panel-border)",
              color: "var(--text-dim)",
              borderRadius: 5,
              padding: "5px 10px",
              fontSize: 11.5,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="range-tabs">
        {RANGES.map((r) => (
          <button key={r.key} className={r.key === range ? "active" : ""} onClick={() => setRange(r.key)}>
            {r.label}
          </button>
        ))}
      </nav>

      <main>
        <section className="kpi-row">
          <div className="kpi" style={{ ["--accent" as any]: "var(--amber)" }}>
            <div className="kpi-label">Revenue</div>
            <div className="kpi-value mono">{kpis ? fmtMoney(kpis.revenue) : "—"}</div>
          </div>
          <div className="kpi" style={{ ["--accent" as any]: "var(--cyan)" }}>
            <div className="kpi-label">Fuel Gallons</div>
            <div className="kpi-value mono">{kpis ? fmtNum(kpis.fuel_gallons, 1) : "—"}</div>
          </div>
          <div className="kpi" style={{ ["--accent" as any]: "var(--tan)" }}>
            <div className="kpi-label">Transactions</div>
            <div className="kpi-value mono">{kpis ? fmtNum(kpis.txn_count) : "—"}</div>
          </div>
          <div className="kpi" style={{ ["--accent" as any]: "var(--rose)" }}>
            <div className="kpi-label">Avg Ticket</div>
            <div className="kpi-value mono">{kpis ? fmtMoney(avgTicket) : "—"}</div>
          </div>
        </section>

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
              placeholder="Search by item, pump, cashier, or payment type…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="feed">
              {filteredFeed.length === 0 && (
                <div className="empty-note">{feed.length === 0 ? "No transactions yet." : "No matches."}</div>
              )}
              {filteredFeed.map((item) => {
                const { chip, label } = feedDescription(item);
                const isNew = !firstLoad.current && !knownIds.current.has(item.unique_id);
                const isOpen = expandedId === item.unique_id;
                const time = new Date(item.date).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                });
                return (
                  <div
                    key={item.unique_id}
                    className={`feed-row ${isNew ? "new" : ""}`}
                    onClick={() => setExpandedId(isOpen ? null : item.unique_id)}
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
                    {isOpen && (
                      <div className="feed-detail" onClick={(e) => e.stopPropagation()}>
                        {item.lines.map((l, i) => (
                          <div className="feed-detail-row" key={i}>
                            <span>
                              {l.description}
                              {l.is_fuel && l.fuel_volume ? ` (${l.fuel_volume.toFixed(3)} gal)` : ""}
                            </span>
                            <span>{fmtMoney(l.line_total || 0)}</span>
                          </div>
                        ))}
                        {item.payments.map((p, i) => (
                          <div className="feed-detail-row" key={`pay-${i}`}>
                            <span>Paid via {p.tender_type}</span>
                            <span>{fmtMoney(p.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
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
            <h2>Top merchandise</h2>
            <button className="export-btn" onClick={() => downloadCSV(`top-merchandise-${range}.csv`, summary?.merch || [])}>
              Export CSV
            </button>
          </div>
          <table className="merch-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Dept</th>
                <th>Qty sold</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {summary?.merch?.length ? (
                summary.merch.map((row: any, i: number) => (
                  <tr key={i}>
                    <td>{row.item ?? "—"}</td>
                    <td>{row.dept ?? "—"}</td>
                    <td>{fmtNum(row.qty, row.qty % 1 ? 2 : 0)}</td>
                    <td>{fmtMoney(row.revenue)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="empty-note">
                    No merchandise sales in this range yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}

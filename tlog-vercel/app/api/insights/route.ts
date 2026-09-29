import { NextRequest, NextResponse } from "next/server";
import { rangeBounds } from "@/lib/dateRange";
import {
  getKpis,
  getPreviousPeriodKpis,
  getHourOfDayBreakdown,
  getDayOfWeekBreakdown,
  getDailyLedger,
  getRepeatCustomers,
  getPumpHealthFlags,
  getBasketAnalysis,
  getIdlePumpCost,
  getClosedDates,
} from "@/lib/db";

export const dynamic = "force-dynamic";

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null; // undefined % change from zero
  return ((current - previous) / previous) * 100;
}

export async function GET(req: NextRequest) {
  const rangeKey = req.nextUrl.searchParams.get("range") ?? "today";
  const { start, end } = rangeBounds(
    rangeKey,
    req.nextUrl.searchParams.get("start"),
    req.nextUrl.searchParams.get("end")
  );

  const [kpis, prevKpis, hourOfDay, dayOfWeek, dailyLedger, repeatCustomers, pumpFlags, basketAnalysis, idlePumpCost, closedDates] =
    await Promise.all([
      getKpis(start, end),
      getPreviousPeriodKpis(start, end),
      getHourOfDayBreakdown(start, end),
      getDayOfWeekBreakdown(start, end),
      getDailyLedger(start, end),
      getRepeatCustomers(start, end),
      getPumpHealthFlags(start, end),
      getBasketAnalysis(start, end),
      getIdlePumpCost(), // not range-scoped - always reflects current idle status regardless of the selected range
      getClosedDates(),
    ]);

  const comparison = {
    previous: prevKpis,
    revenue_change_pct: pctChange(kpis.revenue, prevKpis.revenue),
    txn_count_change_pct: pctChange(kpis.txn_count, prevKpis.txn_count),
    fuel_gallons_change_pct: pctChange(kpis.fuel_gallons, prevKpis.fuel_gallons),
  };

  const busiestHour = hourOfDay.reduce((best, h) => (h.revenue > (best?.revenue ?? -1) ? h : best), null as any);
  const busiestDay = dayOfWeek.reduce((best, d) => (d.revenue > (best?.revenue ?? -1) ? d : best), null as any);

  // Central-time "today" string, same convention used everywhere else a
  // calendar day is derived from a moment in time (see getTodayForecast).
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

  return NextResponse.json({
    range: { key: rangeKey, start, end },
    comparison,
    hour_of_day: hourOfDay,
    day_of_week: dayOfWeek,
    daily_ledger: dailyLedger,
    repeat_customers: repeatCustomers,
    pump_flags: pumpFlags,
    basket_analysis: basketAnalysis,
    idle_pump_cost: idlePumpCost,
    today_closed: closedDates.has(todayStr),
    highlights: {
      busiest_hour: busiestHour,
      busiest_day: busiestDay,
    },
  });
}


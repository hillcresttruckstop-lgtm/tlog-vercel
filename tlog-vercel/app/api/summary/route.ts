import { NextRequest, NextResponse } from "next/server";
import {
  getKpis,
  getTimeseries,
  getFuelByGrade,
  getMerchByDepartment,
  getPaymentMix,
  getPumpActivity,
} from "@/lib/db";

export const dynamic = "force-dynamic";

function rangeBounds(rangeKey: string, startParam: string | null, endParam: string | null) {
  const now = new Date();
  if (rangeKey === "custom" && startParam && endParam) {
    return { start: startParam, end: endParam };
  }

  let start: Date;
  let end: Date = now;

  switch (rangeKey) {
    case "24h":
      start = new Date(now.getTime() - 24 * 3600 * 1000);
      break;
    case "7d":
      start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      break;
    case "30d":
      start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      break;
    case "ytd":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case "year":
      start = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
      break;
    case "today":
    default:
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end = new Date(start.getTime() + 24 * 3600 * 1000);
      break;
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function granularityFor(rangeKey: string): string {
  return (
    { today: "hour", "24h": "hour", "7d": "day", "30d": "day", ytd: "month", year: "month" }[
      rangeKey
    ] ?? "hour"
  );
}

export async function GET(req: NextRequest) {
  const rangeKey = req.nextUrl.searchParams.get("range") ?? "today";
  const { start, end } = rangeBounds(
    rangeKey,
    req.nextUrl.searchParams.get("start"),
    req.nextUrl.searchParams.get("end")
  );
  const granularity = req.nextUrl.searchParams.get("granularity") ?? granularityFor(rangeKey);

  const [kpis, timeseries, fuelByGrade, merch, paymentMix, pumpActivity] = await Promise.all([
    getKpis(start, end),
    getTimeseries(granularity, start, end),
    getFuelByGrade(start, end),
    getMerchByDepartment(start, end),
    getPaymentMix(start, end),
    getPumpActivity(start, end),
  ]);

  return NextResponse.json({
    range: { key: rangeKey, start, end, granularity },
    kpis,
    timeseries,
    fuel_by_grade: fuelByGrade,
    merch,
    payment_mix: paymentMix,
    pump_activity: pumpActivity,
  });
}

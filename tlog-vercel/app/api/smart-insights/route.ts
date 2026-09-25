import { NextResponse } from "next/server";
import { rangeBounds } from "@/lib/dateRange";
import { getTodayForecast, getAnomalies, getRecordCheck } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const { start, end } = rangeBounds("today", null, null);
  const now = new Date();

  const [forecast, anomalies, record] = await Promise.all([
    getTodayForecast(now),
    getAnomalies(start, end),
    getRecordCheck(start, end),
  ]);

  return NextResponse.json({ forecast, anomalies, record });
}

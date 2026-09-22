import { NextRequest, NextResponse } from "next/server";
import { rangeBounds, granularityFor } from "@/lib/dateRange";
import {
  getKpis,
  getTimeseries,
  getFuelByGrade,
  getMerchByDepartment,
  getMerchByCategory,
  getPaymentMix,
  getPumpActivity,
  getVoidCount,
  getLotteryBreakdown,
} from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rangeKey = req.nextUrl.searchParams.get("range") ?? "today";
  const { start, end } = rangeBounds(
    rangeKey,
    req.nextUrl.searchParams.get("start"),
    req.nextUrl.searchParams.get("end")
  );

  let granularity = req.nextUrl.searchParams.get("granularity");
  if (!granularity) {
    if (rangeKey === "custom") {
      const spanDays = (new Date(end).getTime() - new Date(start).getTime()) / (24 * 3600 * 1000);
      granularity = spanDays <= 1 ? "hour" : spanDays <= 90 ? "day" : "month";
    } else {
      granularity = granularityFor(rangeKey);
    }
  }

  const [kpis, timeseries, fuelByGrade, merch, merchByCategory, paymentMix, pumpActivity, voidCount, lottery] =
    await Promise.all([
      getKpis(start, end),
      getTimeseries(granularity, start, end),
      getFuelByGrade(start, end),
      getMerchByDepartment(start, end),
      getMerchByCategory(start, end),
      getPaymentMix(start, end),
      getPumpActivity(start, end),
      getVoidCount(start, end),
      getLotteryBreakdown(start, end),
    ]);

  // Inside Sales (ex-lottery) = Merch Sales - Net Lottery. Formula
  // confirmed exactly against the reference C-Store Back Office tool:
  // $1,265.08 merch - $14.00 net lottery = $1,251.08, to the penny.
  const insideSalesExLottery = kpis.merch_revenue - lottery.net_lottery;

  return NextResponse.json({
    range: { key: rangeKey, start, end, granularity },
    kpis: { ...kpis, void_count: voidCount, inside_sales_ex_lottery: insideSalesExLottery },
    timeseries,
    fuel_by_grade: fuelByGrade,
    merch,
    merch_by_category: merchByCategory,
    payment_mix: paymentMix,
    pump_activity: pumpActivity,
    lottery,
  });
}

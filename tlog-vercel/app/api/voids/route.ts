import { NextRequest, NextResponse } from "next/server";
import { rangeBounds } from "@/lib/dateRange";
import { getVoidTickets, getVoidLines } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rangeKey = req.nextUrl.searchParams.get("range") ?? "today";
  const { start, end } = rangeBounds(
    rangeKey,
    req.nextUrl.searchParams.get("start"),
    req.nextUrl.searchParams.get("end")
  );

  const [tickets, lines] = await Promise.all([getVoidTickets(start, end), getVoidLines(start, end)]);

  return NextResponse.json({ tickets, lines });
}

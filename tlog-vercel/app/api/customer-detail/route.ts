import { NextRequest, NextResponse } from "next/server";
import { rangeBounds } from "@/lib/dateRange";
import { getCardDetail } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const card = req.nextUrl.searchParams.get("card");
  if (!card) {
    return NextResponse.json({ error: "Missing ?card=" }, { status: 400 });
  }
  const rangeKey = req.nextUrl.searchParams.get("range") ?? "today";
  const { start, end } = rangeBounds(
    rangeKey,
    req.nextUrl.searchParams.get("start"),
    req.nextUrl.searchParams.get("end")
  );
  const detail = await getCardDetail(card, start, end);
  return NextResponse.json(detail);
}

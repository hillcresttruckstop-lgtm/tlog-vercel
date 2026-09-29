import { NextRequest, NextResponse } from "next/server";
import { getLiveFeed } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const hoursParam = req.nextUrl.searchParams.get("hours");
  const hours = hoursParam ? Number(hoursParam) : null;
  // Safety cap - protects against an unbounded result on a genuinely huge
  // window or an extraordinarily busy stretch, regardless of what's asked for.
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? (hours ? "1000" : "40"));
  const feed = await getLiveFeed(limit, hours);
  return NextResponse.json(feed);
}

import { NextRequest, NextResponse } from "next/server";
import { getLiveFeed } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "40");
  const feed = await getLiveFeed(limit);
  return NextResponse.json(feed);
}

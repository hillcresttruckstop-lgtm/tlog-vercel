import { NextResponse } from "next/server";
import { getStatus } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getStatus();
  return NextResponse.json(status);
}

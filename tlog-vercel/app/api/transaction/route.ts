import { NextRequest, NextResponse } from "next/server";
import { getTransactionById } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing ?id=" }, { status: 400 });
  }
  const txn = await getTransactionById(id);
  if (!txn) {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }
  return NextResponse.json(txn);
}

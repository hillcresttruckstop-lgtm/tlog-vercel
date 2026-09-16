/**
 * proxy.ts
 * =========
 * Runs on every request (Vercel Edge runtime). Anything that isn't the
 * login page, the login API, static assets, or /api/ingest (which is
 * called by your external cron scheduler using its own secret, not a
 * logged-in browser session) requires a valid session cookie - otherwise
 * it's redirected to /login (for page loads) or gets a 401 (for API
 * calls the dashboard's own JS makes).
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, COOKIE_NAME } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/login", "/api/ingest"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;
  const authed = token ? await verifySessionToken(token) : false;

  if (!authed) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next's internal assets, favicon, and static
  // image files under /public - those need to load on the LOGIN PAGE
  // ITSELF, before anyone is authenticated (the login screen's own logo
  // is one of them), so they can't be behind the same gate as real data.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif)$).*)"],
};

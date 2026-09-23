/**
 * proxy.ts
 * =========
 * Runs on every request (Vercel Edge runtime). Anything that isn't the
 * login page, the login API, static assets, or /api/ingest / /api/admin/reset
 * (called by an external scheduler or by hand using their own secret, not
 * a logged-in browser session) requires a valid session cookie - otherwise
 * it's redirected to /login (for page loads) or gets a 401 (for API
 * calls the dashboard's own JS makes).
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, COOKIE_NAME } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/login", "/api/ingest", "/api/admin/reset", "/api/admin/diagnose"];

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
  // Run on everything except Next's internal assets, favicon, static image
  // files, and the web app manifest under /public - those need to load
  // without any login context (the manifest specifically is fetched by
  // the browser/OS itself when deciding whether "Add to Home Screen" is
  // available, which happens with no session at all).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest\\.webmanifest|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif)$).*)"],
};

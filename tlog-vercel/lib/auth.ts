/**
 * auth.ts
 * ========
 * A deliberately simple single-account login: one username + password
 * (set as env vars), a signed session cookie on success. No user table,
 * no third-party auth provider - this is a private one-owner dashboard,
 * not a multi-tenant product, so that's the right amount of complexity.
 *
 * Uses `jose` (not Node's built-in crypto) because middleware.ts runs on
 * Vercel's Edge runtime, which doesn't support Node's crypto module -
 * jose works in both.
 */

import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "session";
const SESSION_DURATION = "30d";

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set (add it in Vercel project settings).");
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_DURATION)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload.authenticated === true;
  } catch {
    return false; // expired, tampered, or malformed - treat all as "not logged in"
  }
}

export { COOKIE_NAME };

/** Constant-time-ish credential check - avoids leaking match length via
 * early-exit string comparison timing. Good enough for a single-account
 * login gate (not defending against a sophisticated timing attack, just
 * not doing the obviously worse `===` on raw secrets). */
export function checkCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.AUTH_USERNAME ?? "";
  const expectedPass = process.env.AUTH_PASSWORD ?? "";
  if (!expectedUser || !expectedPass) return false;
  return timingSafeEqual(username, expectedUser) && timingSafeEqual(password, expectedPass);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

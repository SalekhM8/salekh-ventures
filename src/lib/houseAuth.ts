/* Sign-in for the private house. There is one owner. A sign-in link is emailed
   to the owner's address only (never to an address typed into the page), and
   opening it sets a signed, http-only session cookie. No password exists.

   Needs HOUSE_SESSION_SECRET (32+ characters). Without it nobody can sign in
   and the house stays the public demo. */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "wh_session";
export const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

const secret = () => {
  const s = process.env.HOUSE_SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
};

const mac = (kind: string, expires: number, key: string) => createHmac("sha256", key).update(`${kind}.${expires}`).digest("base64url");

function make(kind: "link" | "session", seconds: number): string | null {
  const key = secret();
  if (!key) return null;
  const expires = Math.floor(Date.now() / 1000) + seconds;
  return `${expires}.${mac(kind, expires, key)}`;
}

function check(kind: "link" | "session", token: string | undefined | null): boolean {
  const key = secret();
  if (!key || !token) return false;
  const [exp, sig, ...rest] = token.split(".");
  const expires = Number(exp);
  if (rest.length > 0 || !sig || !Number.isInteger(expires) || expires < Date.now() / 1000) return false;
  const want = Buffer.from(mac(kind, expires, key));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const authConfigured = () => secret() !== null;
export const makeLinkToken = () => make("link", LINK_MINUTES * 60);
export const checkLinkToken = (t: string | null | undefined) => check("link", t);
export const makeSession = () => make("session", SESSION_DAYS * 86400);
export const checkSession = (t: string | null | undefined) => check("session", t);

/** Whether this request may use the live house: always on a local dev server, otherwise only with a session. */
export function mayUseLiveHouse(sessionCookie: string | undefined): boolean {
  if (process.env.NODE_ENV === "development") return true;
  return checkSession(sessionCookie);
}

import { cookies } from "next/headers";
import { checkLinkToken, makeSession, SESSION_COOKIE, SESSION_DAYS } from "@/lib/houseAuth";

/* Opened from the emailed link. A good link sets the session cookie and goes to the house. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = checkLinkToken(url.searchParams.get("t")) ? makeSession() : null;
  if (!session) return Response.redirect(new URL("/house/sign-in?link=expired", url.origin), 303);
  (await cookies()).set(SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86400 });
  return Response.redirect(new URL("/house", url.origin), 303);
}

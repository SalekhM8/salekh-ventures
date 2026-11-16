"use server";

import { authConfigured, makeLinkToken } from "@/lib/houseAuth";

const SITE = "https://www.salekhventures.com";

// One link a minute per server instance. The link only ever goes to the owner's own address,
// so the worst a stranger can do is cause the owner an unwanted email; this keeps that rare.
let lastSent = 0;

/** Emails a sign-in link to the owner. Always answers the same way, whatever happened. */
export async function requestHouseLink(): Promise<{ ok: true }> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.HOUSE_OWNER_EMAIL || process.env.CONTACT_TO_EMAIL;
  const from = process.env.CONTACT_FROM_EMAIL || "Salekh Ventures <onboarding@resend.dev>";
  const token = makeLinkToken();
  const now = Date.now();
  if (!authConfigured() || !apiKey || !to || !token || now - lastSent < 60_000) return { ok: true };
  lastSent = now;
  const link = `${SITE}/api/house-auth/verify?t=${encodeURIComponent(token)}`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        subject: "Your White House sign-in link",
        text: `Open this link to sign in to the White House. It works for 15 minutes.\n\n${link}\n\nIf you did not ask for this, ignore it. Nobody can sign in without opening this link.`,
      }),
    });
    if (!res.ok) console.error("[house] sign-in email failed:", res.status);
  } catch {
    console.error("[house] sign-in email network error");
  }
  return { ok: true };
}

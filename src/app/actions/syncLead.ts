"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";

const META_PIXEL_ID = "2052226205397501";
const PAGE_URL = "https://salekhventures.com/sync";

type SyncLeadPayload = {
  name: string;
  email: string;
  phone: string;
  platforms: string[];
  products: string;
  stock: string;
  pricing?: string;
};

export type SyncLeadResult =
  | { ok: true; eventId: string }
  | { ok: false; error: string };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Meta wants phones hashed as digits with country code, no leading zero.
function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) return `44${digits.slice(1)}`;
  return digits;
}

// Server-side Lead via Conversions API, deduplicated against the browser
// pixel event by sharing the same eventId. Failure here must never fail
// the lead itself.
async function sendMetaLead(
  payload: SyncLeadPayload,
  eventId: string,
  clientIp: string | null,
  userAgent: string | null
) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) {
    console.log("[sync] No META_CAPI_ACCESS_TOKEN set — skipping CAPI event.");
    return;
  }

  const userData: Record<string, unknown> = {
    em: [sha256(payload.email.trim().toLowerCase())],
    ph: [sha256(normalizePhone(payload.phone))],
  };
  if (clientIp) userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: PAGE_URL,
        user_data: userData,
      },
    ],
  };
  // Set META_TEST_EVENT_CODE (from Events Manager → Test events) to route
  // server events into the Test Events tab while verifying dedup; remove after.
  if (process.env.META_TEST_EVENT_CODE) {
    body.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      console.error("[sync] CAPI error:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[sync] CAPI network error:", err);
  }
}

export async function submitSyncLead(
  _prev: SyncLeadResult | null,
  formData: FormData
): Promise<SyncLeadResult> {
  const payload: SyncLeadPayload = {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim(),
    platforms: formData.getAll("platforms").map(String),
    products: String(formData.get("products") ?? "").trim(),
    stock: String(formData.get("stock") ?? "").trim(),
    pricing: String(formData.get("pricing") ?? "").trim() || undefined,
  };
  const eventId = String(formData.get("eventId") ?? "").trim() || crypto.randomUUID();

  // Ad attribution from the landing URL's query string.
  const attribution: string[] = [];
  try {
    const p = new URLSearchParams(String(formData.get("utm") ?? ""));
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      const v = p.get(k);
      if (v) attribution.push(`${k.replace("utm_", "")}: ${v}`);
    }
    if (p.get("fbclid")) attribution.push("fbclid: present (Meta ad click)");
  } catch {}

  if (!payload.name) return { ok: false, error: "Name is required." };
  if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return { ok: false, error: "Please enter a valid email." };
  }
  if (!payload.phone || payload.phone.replace(/\D/g, "").length < 7) {
    return { ok: false, error: "Please enter a valid phone number." };
  }
  if (payload.platforms.length === 0) {
    return { ok: false, error: "Tick at least one platform you sell on." };
  }
  if (!payload.products) {
    return { ok: false, error: "Select roughly how many products you list." };
  }
  if (!payload.stock) {
    return {
      ok: false,
      error: "Pick how you keep stock matching today.",
    };
  }
  if (!payload.pricing) {
    return {
      ok: false,
      error: "Pick whether you know your profit after fees.",
    };
  }

  const h = await headers();
  const clientIp =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent");

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL || "hello@salekhventures.com";
  const from =
    process.env.CONTACT_FROM_EMAIL || "Salekh Ventures <onboarding@resend.dev>";

  const emailText = [
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Phone: ${payload.phone}`,
    `Platforms: ${payload.platforms.join(", ")}`,
    `Products listed: ${payload.products}`,
    `Stock sync today: ${payload.stock}`,
    `Knows profit after fees: ${payload.pricing ?? "-"}`,
    ...(attribution.length ? ["", "Came from:", ...attribution] : []),
  ].join("\n");

  // If no Resend key is configured yet, log and accept — so the form works locally.
  if (!apiKey) {
    console.log("[sync] No RESEND_API_KEY set. Submission:", payload);
    await sendMetaLead(payload, eventId, clientIp, userAgent);
    return { ok: true, eventId };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        reply_to: payload.email,
        subject: `SYNC LEAD — ${payload.name} (${payload.platforms.join(" + ")})`,
        text: emailText,
      }),
    });

    if (!res.ok) {
      console.error("[sync] Resend error:", res.status, await res.text());
      return {
        ok: false,
        error:
          "Could not send right now. Please email hello@salekhventures.com directly.",
      };
    }
  } catch (err) {
    console.error("[sync] Network error:", err);
    return {
      ok: false,
      error: "Network error. Please try again or email directly.",
    };
  }

  await sendMetaLead(payload, eventId, clientIp, userAgent);

  // Warm auto-reply to the lead so the follow-up text/call isn't from a
  // stranger. Failure here must never fail the lead.
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: payload.email,
        reply_to: to,
        subject: "Got your details, quick heads up",
        text: [
          `Hi ${payload.name.split(" ")[0]},`,
          "",
          "Salekh here. Your form just came through and I've read your answers, so I already have a decent picture of your setup.",
          "",
          "I'll text you today from my personal number to sort a quick 10 minute call, so if a UK mobile you don't recognise messages you, that's me.",
          "",
          "Nothing to do until then. Talk soon,",
          "Salekh",
          "salekhventures.com/sync",
        ].join("\n"),
      }),
    });
  } catch (err) {
    console.error("[sync] Auto-reply error:", err);
  }

  return { ok: true, eventId };
}

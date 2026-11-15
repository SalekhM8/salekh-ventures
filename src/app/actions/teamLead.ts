"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";

const META_PIXEL_ID = "2052226205397501";
const PAGE_URL = "https://salekhventures.com/";

export type TeamLead = {
  niche: string;
  departments: string[];
  agents?: string[];
  followUp?: { question: string; answer: string };
  teamSize: string;
  revenue: string;
  timing: string;
  name: string;
  business: string;
  website?: string;
  phone: string;
  email?: string;
  attribution?: string;
  eventId?: string;
};

export type TeamLeadResult = { ok: true; eventId: string } | { ok: false; error: string };

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

// Meta wants phones hashed as digits with country code, no leading zero.
function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? `44${digits.slice(1)}` : digits;
}

const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

// Server-side Lead via the Conversions API, deduplicated against the browser
// pixel by sharing the event id. A failure here must never fail the lead.
async function sendMetaLead(lead: TeamLead, eventId: string, ip: string | null, ua: string | null) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) return;
  const userData: Record<string, unknown> = { ph: [sha256(normalizePhone(lead.phone))] };
  if (lead.email) userData.em = [sha256(lead.email.toLowerCase())];
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  const body: Record<string, unknown> = {
    data: [{ event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: eventId, action_source: "website", event_source_url: PAGE_URL, user_data: userData }],
  };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("[team] CAPI error:", res.status);
  } catch (err) {
    console.error("[team] CAPI network error:", err);
  }
}

export async function submitTeamLead(input: TeamLead): Promise<TeamLeadResult> {
  const lead: TeamLead = {
    niche: clean(input.niche, 80),
    departments: Array.isArray(input.departments) ? input.departments.slice(0, 12).map((d) => clean(d, 60)) : [],
    agents: Array.isArray(input.agents) ? input.agents.slice(0, 60).map((a) => clean(a, 60)).filter(Boolean) : [],
    followUp: input.followUp ? { question: clean(input.followUp.question, 120), answer: clean(input.followUp.answer, 80) } : undefined,
    teamSize: clean(input.teamSize, 40),
    revenue: clean(input.revenue, 60),
    timing: clean(input.timing, 60),
    name: clean(input.name, 80),
    business: clean(input.business, 120),
    website: clean(input.website, 160) || undefined,
    phone: clean(input.phone, 30),
    email: clean(input.email, 120) || undefined,
  };
  const eventId = clean(input.eventId, 64) || crypto.randomUUID();

  if (!lead.name) return { ok: false, error: "Please add your name." };
  if (lead.phone.replace(/\D/g, "").length < 9) return { ok: false, error: "Please enter a phone number we can reach you on." };
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return { ok: false, error: "That email doesn't look right. Fix it or leave it blank." };
  if (lead.departments.length === 0) return { ok: false, error: "Pick at least one department." };

  const attribution: string[] = [];
  try {
    const p = new URLSearchParams(clean(input.attribution, 600));
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      const v = p.get(k);
      if (v) attribution.push(`${k.replace("utm_", "")}: ${v.slice(0, 80)}`);
    }
    if (p.get("fbclid")) attribution.push("fbclid: present (Meta ad click)");
  } catch {}

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  const text = [
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    `Business: ${lead.business || "-"}`,
    `Website or social: ${lead.website ?? "-"}`,
    `Email: ${lead.email ?? "-"}`,
    "",
    `Kind of business: ${lead.niche}`,
    `Departments wanted: ${lead.departments.join(", ")}`,
    `Agents picked (${lead.agents?.length ?? 0}): ${lead.agents?.length ? lead.agents.join(", ") : "none picked"}`,
    ...(lead.followUp ? [`${lead.followUp.question} ${lead.followUp.answer}`] : []),
    `Monthly revenue: ${lead.revenue || "-"}`,
    `Team size: ${lead.teamSize}`,
    `Timing: ${lead.timing}`,
    ...(attribution.length ? ["", "Came from:", ...attribution] : []),
  ].join("\n");

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL || "hello@salekhventures.com";
  const from = process.env.CONTACT_FROM_EMAIL || "Salekh Ventures <onboarding@resend.dev>";

  // With no Resend key (local development) log and accept, so the form works.
  if (!apiKey) {
    console.log("[team] No RESEND_API_KEY set. Lead received:\n" + text);
    return { ok: true, eventId };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        ...(lead.email ? { reply_to: lead.email } : {}),
        subject: `AI TEAM LEAD: ${lead.name}, ${lead.niche}, ${lead.revenue || "revenue not given"} (${lead.phone})`,
        text,
      }),
    });
    if (!res.ok) {
      console.error("[team] Resend error:", res.status);
      return { ok: false, error: "Could not send right now. Please try again in a minute." };
    }
  } catch (err) {
    console.error("[team] Network error:", err);
    return { ok: false, error: "Network error. Please try again." };
  }

  await sendMetaLead(lead, eventId, ip, ua);
  return { ok: true, eventId };
}

import { SIGNALS, type OutreachSettings, type Signal } from "./settings.js";

/**
 * The filter rules and the score. Plain code: no model takes part in deciding
 * who makes the shortlist or in what order (rule 2, rules before models).
 *
 * FILTERS, checked in this order. The first that fails is the reason recorded.
 *   not_analysed                   there is no analysis yet
 *   part_of_group                  part of a group or chain (its pages say so, it is on the excluded
 *                                  list, or it shows ten or more premises). An owner with two or
 *                                  three sites is not a group
 *   not_limited_company            Companies House, or the business itself, says it is not one
 *   no_signal                      none of the signals looked for was seen
 *   no_named_contact               no named person to contact
 *   limited_company_not_confirmed  could not be confirmed (see the setting for "not checked")
 *   no_contact_route               no way for anyone to enquire was found
 *   no_money_signal                no high value service, no adverts, not several staff, one location
 *
 * The brief's first filter, "replied slowly or not at all", needs the mystery
 * enquiry, which is not built. It is not applied and not scored, and every
 * card says so.
 *
 * SCORE, out of 100, weights from settings (defaults shown):
 *   signals   25 hiring for the front desk, 15 Meta adverts, 10 weak social,
 *             10 poor reviews; added together, at most 45
 *   money     10 a high value service found, 10 adverts seen running,
 *             10 for five or more staff or 5 for several (three or four),
 *             5 for two or more locations; at most 30
 *   reach     5 a named contact, plus each kind of route once: WhatsApp 4,
 *             Instagram 3, phone 3, Facebook 2, form 1, email 1, booking 1;
 *             routes at most 10. (Salekh does not email prospects, so the
 *             routes he can use by hand weigh most.)
 *   limited   10 when confirmed a limited company
 *   reply     nothing yet: not tested
 */

export type Fact = "not found" | { value: string; source_url: string };
export type Counted = "not found" | { count: number; source_url: string };

export interface Analysis {
  what_they_sell: Fact;
  highest_value_service: Fact;
  staff_count: Counted;
  locations: Counted;
  runs_ads: "not found" | { value: "yes" | "no"; source_url: string };
  reviews: "not found" | { count: number; rating: number; source_url: string };
  legal_form: "not found" | { value: "limited_company" | "sole_trader" | "partnership" | "other"; source_url: string };
  [other: string]: unknown;
}

export interface Scorable {
  /** For recognising a group by name. */
  name?: string;
  website?: string | null;
  companyName?: string | null;
  /** Confirmed signals only. A match that is only a guess is not passed in here. */
  signals: string[];
  analysis: Analysis | null;
  contactName: string | null;
  routes: { kind: string }[];
  isLimitedCompany: "yes" | "no" | "not_found" | "not_checked";
}

export type FilterReason =
  | "not_analysed" | "part_of_group" | "not_limited_company" | "no_signal" | "no_named_contact" | "limited_company_not_confirmed" | "no_contact_route" | "no_money_signal";

const counted = (value: Counted | undefined): number => (typeof value === "object" && value !== null && Number.isFinite(value.count) ? value.count : 0);
const found = (value: unknown): boolean => typeof value === "object" && value !== null;

const plain = (text: unknown): string => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The group on the excluded list that this text names, if any. Accents, case and spacing are ignored. */
export function namedGroup(text: unknown, settings: OutreachSettings): string | null {
  const hay = plain(text);
  return hay ? (settings.excluded_groups.find((group) => plain(group).length >= 4 && hay.includes(plain(group))) ?? null) : null;
}

/**
 * Part of a group or chain: its pages say so, its name, site or registered company is a group on the excluded
 * list, or it shows as many premises as a chain has. An owner with two or three sites is not a group.
 */
export function isGroup(p: Scorable, settings: OutreachSettings): boolean {
  const a = p.analysis;
  if (a && typeof a.group === "object" && a.group !== null) return true;
  if (namedGroup(p.name, settings) || namedGroup(p.website, settings) || namedGroup(p.companyName, settings)) return true;
  return counted(a?.locations) >= settings.chain_locations;
}

export function applyFilters(p: Scorable, settings: OutreachSettings): { keep: true } | { keep: false; reason: FilterReason } {
  const f = settings.filters;
  const a = p.analysis;
  if (!a) return { keep: false, reason: "not_analysed" };
  if (f.exclude_groups && isGroup(p, settings)) return { keep: false, reason: "part_of_group" };
  const saysNotLimited = typeof a.legal_form === "object" && (a.legal_form.value === "sole_trader" || a.legal_form.value === "partnership");
  if (f.require_limited_company && (p.isLimitedCompany === "no" || (p.isLimitedCompany !== "yes" && saysNotLimited))) {
    return { keep: false, reason: "not_limited_company" };
  }
  if (f.require_signal && p.signals.length === 0) return { keep: false, reason: "no_signal" };
  if (f.require_named_contact && !p.contactName) return { keep: false, reason: "no_named_contact" };
  if (f.require_limited_company) {
    const unconfirmed = p.isLimitedCompany === "not_found" || (p.isLimitedCompany === "not_checked" && !f.allow_unchecked_limited_company);
    if (unconfirmed) return { keep: false, reason: "limited_company_not_confirmed" };
  }
  if (f.require_contact_route && p.routes.length === 0) return { keep: false, reason: "no_contact_route" };
  if (f.require_money_signal) {
    const money =
      found(a.highest_value_service) ||
      (typeof a.runs_ads === "object" && a.runs_ads.value === "yes") ||
      counted(a.staff_count) >= f.several_staff ||
      counted(a.locations) >= 2;
    if (!money) return { keep: false, reason: "no_money_signal" };
  }
  return { keep: true };
}

export interface ScoreBreakdown {
  signals: number;
  money: number;
  reach: number;
  limited_company: number;
  reply_speed: null;
  reply_speed_note: string;
}

export function scoreProspect(p: Scorable, settings: OutreachSettings): { score: number; breakdown: ScoreBreakdown } {
  const w = settings.score_weights;
  const a = p.analysis;
  const signals = Math.min(
    w.signal_cap,
    [...new Set(p.signals)].reduce((sum, s) => sum + ((w.signal as Record<string, number>)[s] ?? 0), 0),
  );
  let money = 0;
  if (a) {
    if (found(a.highest_value_service)) money += w.high_value_service;
    if (typeof a.runs_ads === "object" && a.runs_ads.value === "yes") money += w.runs_ads;
    const staff = counted(a.staff_count);
    if (staff >= 5) money += w.staff_five_or_more;
    else if (staff >= settings.filters.several_staff) money += w.staff_several;
    if (counted(a.locations) >= 2) money += w.two_or_more_locations;
  }
  money = Math.min(w.money_cap, money);
  const kinds = [...new Set(p.routes.map((r) => r.kind))];
  const routes = Math.min(w.route_cap, kinds.reduce((sum, kind) => sum + ((w.route as Record<string, number>)[kind] ?? 0), 0));
  const reach = (p.contactName ? w.named_contact : 0) + routes;
  const limited = p.isLimitedCompany === "yes" ? w.limited_company_confirmed : 0;
  return {
    score: Math.min(100, signals + money + reach + limited),
    breakdown: { signals, money, reach, limited_company: limited, reply_speed: null, reply_speed_note: "not tested yet, so not part of this score" },
  };
}

/** The agent a message leads with: the strongest signal present, in the order the signals are listed. */
export function leadAgentFor(signals: string[], settings: OutreachSettings): string {
  const strongest = SIGNALS.find((s) => signals.includes(s)) as Signal | undefined;
  return strongest ? settings.lead_agent_by_signal[strongest] : settings.lead_agent_by_signal.hiring_front_desk;
}

export interface Draft {
  why: string;
  sample_reply: string;
  first_message: string;
  call_opener: string;
}

// The first message is a direct message sent by hand, not an email: a few sentences.
const LIMITS: Record<keyof Draft, number> = { why: 400, sample_reply: 1200, first_message: 500, call_opener: 200 };
const RULES: { test: RegExp; fields: (keyof Draft)[]; problem: string }[] = [
  { test: /\b(we|i|our team) (have |had )?(tested|tried|sent (you |your \w+ )?an? (test )?(enquiry|message|email))|\bmystery\b|\btest(ed)? (enquiry|message|your)\b|took you .{0,20}to (reply|respond|answer)|you (didn't|did not|never) (reply|respond|answer)/i,
    fields: ["why", "first_message", "call_opener"], problem: "it says or implies an enquiry was tested. No enquiry has been tested, so this cannot be said" },
  { test: /\d+(\.\d+)? ?(%|per ?cent)|£ ?\d|\b\d+ ?x\b|\b(double|triple|treble)[sd]?\b/i,
    fields: ["why", "first_message", "call_opener"], problem: "it quotes a number or a result. Nothing has been measured for this business, so no figures" },
  { test: /guarantee|revolutionar|game.?chang|cutting.?edge|supercharg|skyrocket|transform your|unlock|world.?class|state.of.the.art|10x|effortless/i,
    fields: ["why", "first_message", "call_opener", "sample_reply"], problem: "it uses hype or a guarantee. Plain words only" },
  { test: /^\s*subject\s*:|\bdear\b|kind regards|yours (sincerely|faithfully)|best regards/im,
    fields: ["first_message"], problem: "it reads like an email. It is a short direct message sent by hand: no subject line, no letter opening or sign-off" },
];

/**
 * The route that looks best for Salekh to use by hand, with the reason, as fixed words.
 * He does not email prospects, so email is never suggested.
 */
export function bestRoute(routes: { kind: string; value: string }[]): { kind: string; value: string; why: string } | null {
  const order: [string, string][] = [
    ["whatsapp", "a WhatsApp link is published, so a short message reaches the front desk directly"],
    ["instagram", "an Instagram account is published, so a short direct message can be sent by hand"],
    ["phone", "a phone number is published and nothing for direct messages was found, so a call is the direct way"],
    ["facebook", "a Facebook page is published, so a short message can be sent by hand"],
    ["form", "only a contact form was found for messages, so it is the one written route"],
  ];
  for (const [kind, why] of order) {
    const hit = routes.find((r) => r.kind === kind);
    if (hit) return { kind, value: hit.value, why };
  }
  return null;
}

/**
 * Rules a drafted card must pass before it is saved. Returns what is wrong, or nothing.
 *
 * `tested` false: no enquiry was sent, so the card may not say or imply one was.
 * `tested` true: an enquiry was sent, and the first message must say plainly that it was a test.
 * Either way: no percentages, money amounts or multiples, no guarantee, no hype, and it is not an email.
 */
export function lintDraft(draft: Draft, tested = false): string[] {
  const problems: string[] = [];
  for (const field of Object.keys(LIMITS) as (keyof Draft)[]) {
    const text = draft[field];
    if (typeof text !== "string" || text.trim().length === 0) problems.push(`${field}: it is empty`);
    else if (text.length > LIMITS[field]) problems.push(`${field}: it is longer than ${LIMITS[field]} characters. Keep it short`);
  }
  for (const [index, rule] of RULES.entries()) {
    if (tested && index === 0) continue;
    for (const field of rule.fields) {
      if (typeof draft[field] === "string" && rule.test.test(draft[field])) problems.push(`${field}: ${rule.problem}`);
    }
  }
  if (tested && typeof draft.first_message === "string" && !/\btest/i.test(draft.first_message)) {
    problems.push("first_message: it must say plainly that the enquiry was a test that Salekh sent");
  }
  return problems;
}

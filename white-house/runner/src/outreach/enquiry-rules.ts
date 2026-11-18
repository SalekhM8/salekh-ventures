import type { OutreachSettings } from "./settings.js";

/**
 * The rules for the test enquiry and the capture score. All plain code.
 *
 * THE ENQUIRY. Salekh's rules, each checked here before a draft can become
 * a proposal: it is short; it asks about a price or about availability; it
 * says nothing about anyone's health; it does not ask to book; it makes no
 * claim to be a patient; it has no links; and it is signed with his own
 * first name. Nothing in it may be false about who is asking.
 *
 * THE CAPTURE SCORE, out of 100: how well a business captures the money
 * coming to it. Six parts. A part that cannot be measured is left out and
 * the score is scaled over the parts that were, and the number of parts
 * measured is always stated with it.
 *
 *   (Each kind of business adds its own forbidden topics, and the reason given back when one is found.)
 *
 *   reply speed (50)    a person's first reply to the enquiry: within 15 minutes 50, within an hour 42,
 *                       within 4 hours 32, later the same day 22, within 24 hours 12, none 0.
 *                       An automatic acknowledgement is noted and is not a reply.
 *   reply quality (20)  answered the question asked 12, offered a next step 8. No reply scores 0.
 *   follow up (10)      sent a second message of their own 10.
 *   routes (20)         4 for each kind of enquiry route offered, up to three kinds, and 8 if one of
 *                       them works out of hours (online booking, a form, WhatsApp).
 *   reviews answered    not measured: no reliable source yet.
 *   social activity     not measured: no reliable source yet.
 */

export interface EnquiryDraft {
  subject: string;
  body: string;
}

const ASKS = /\b(price|prices|pricing|cost|costs|how much|fee|fees|quote|availab|appointment|when|how soon|waiting|wait time|earliest|times)\b/i;
const BOOKS = /\b(book me|book (it|this|that|one) (in|for me)|i('d| would) like to book|i want to book|please book|can you book|put me down|reserve (me|a slot)|schedule me|sign me up|i('ll| will) take (it|the))\b/i;
const PATIENT = /\b(i am|i'm|as) (a |an |one of your )?(current |existing |registered |former |new )?(patient|client|customer)s?\b|\bregistered with you\b|\bmy last (visit|appointment)\b|\bwhen i (came|visited)\b/i;
const ADDRESS = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b|\b(i|we) live (at|on|in)\b|\bmy (home )?address\b|\b\d{1,4} [A-Z][a-z]+ (Road|Street|Avenue|Lane|Close|Drive|Way)\b/;
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.uk|org|net|io)\b/i;

const VAGUE = /\b(your|the|their|our) (\w+ ){0,2}services\b|\blegal (work|services|matters)\b|\bcomprehensive care\b|\bgeneral (enquiry|pricing|prices|care)\b|\bprice list\b|\ball (your|the) (treatments|services)\b/i;
const TIME_OF_DAY = /\bgood (morning|afternoon|evening|day)\b/i;

/** The named services of a kind of business, with the default one for a kind where the trade itself is enough. */
function namedServices(settings: OutreachSettings): { name: string; terms: string[] }[] {
  const type = settings.type;
  // The default's own words stand for it: "a new patient consultation" is named by "consultation".
  const words = type.default_service.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 6);
  return [...type.target_services, { name: type.default_service, terms: words.length > 0 ? words : [type.default_service.toLowerCase()] }];
}

/**
 * The one named service to ask a business about, or null when it offers none of the services looked for.
 * Read from what the analysis found on its own pages, and always given back as the name on the kind's list:
 * never the business's own wording, which may be a whole price list or a vague phrase.
 */
export function serviceFor(analysis: Record<string, unknown> | null | undefined, settings: OutreachSettings): string | null {
  const type = settings.type;
  const said = (key: string): string => {
    const field = analysis?.[key] as { value?: unknown } | string | undefined;
    return typeof field === "object" && field !== null && typeof field.value === "string" ? field.value.toLowerCase() : "";
  };
  // What the analysis named as the target service comes first, then the highest value service, then everything it sells.
  for (const text of [said("target_service"), said("highest_value_service"), said("what_they_sell")]) {
    if (!text) continue;
    const hit = type.target_services.find((service) => service.terms.some((term) => text.includes(term)));
    if (hit) return hit.name;
  }
  return type.require_target_service ? null : type.default_service;
}

/**
 * What is wrong with a drafted enquiry, in fixed words. Empty: it may go forward. These checks are the only
 * gate when enquiries send themselves, so they are made when it is drafted and again in the moment before it is sent.
 * `service`: the named service it was asked to be about, when that is known.
 */
export function lintEnquiry(draft: EnquiryDraft, settings: OutreachSettings, service?: string | null): string[] {
  const problems: string[] = [];
  const subject = typeof draft.subject === "string" ? draft.subject.trim() : "";
  const body = typeof draft.body === "string" ? draft.body.trim() : "";
  if (!subject || subject.length > 100 || /[\r\n]/.test(subject)) problems.push("the subject must be one short line");
  if (!body) return [...problems, "the enquiry is empty"];
  if (body.length > settings.enquiry_max_chars) problems.push(`it is longer than ${settings.enquiry_max_chars} characters`);
  const text = `${subject}\n${body}`;
  if (!body.includes("?") || !ASKS.test(text)) problems.push("it must ask a question about price or availability");
  const lower = text.toLowerCase();
  const health = settings.enquiry_forbidden_words.find((word) => new RegExp(`\\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lower));
  if (health) problems.push(settings.type.forbidden_reason);
  if (ADDRESS.test(text)) problems.push("it gives an address or a postcode. Say nothing about where the person asking lives");
  if (BOOKS.test(text)) problems.push("it asks to book. An enquiry never books an appointment");
  if (PATIENT.test(text)) problems.push("it claims to be a patient or customer. Nothing false may be said about who is asking");
  if (LINK.test(text)) problems.push("it contains a link or a web address");
  // It must name one specific service: the one it was given, or failing that one of this kind's named services.
  const named = namedServices(settings);
  const wanted = service ? named.filter((n) => n.name === service) : [];
  const names = (list: { terms: string[] }[]) => list.some((n) => n.terms.some((term) => lower.includes(term)));
  if (wanted.length > 0 ? !names(wanted) : !names(named)) {
    problems.push(`it does not name a specific service. Ask about this and nothing else: ${service ?? named[0]?.name ?? settings.type.default_service}`);
  } else if (VAGUE.test(text)) problems.push("it is vague (it asks about services in general). Ask about the one named service only");
  if (TIME_OF_DAY.test(text)) problems.push("it greets by the time of day, which may be wrong when it is sent. Use Hello or Hi");
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.at(-1) !== settings.enquiry_signoff) problems.push(`it must end with the sign-off "${settings.enquiry_signoff}" on its own line`);
  return problems;
}

/** Is this message from a machine? true or false when the headers or the subject settle it, null when they do not. */
export function isAutomatic(headers: Record<string, string>, subject: string): boolean | null {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase().trim()]));
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"]) return true;
  if (/\b(bulk|auto_reply|auto-reply|junk|list)\b/.test(h.precedence ?? "")) return true;
  if (/^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|thank you for (your )?(enquiry|email|message)\b.*\(auto)/i.test(subject)) return true;
  return null;
}

const OPT_OUT = /\b(do not|don't|please don't|stop|never) (contact|email|e-mail|message|write to) (me|us)\b|\bunsubscribe\b|\bremove (me|us|this address) from\b|\bno further (contact|emails|correspondence)\b|\bdo not (contact|email) (this|again)\b/i;

/** Does the reply ask not to be contacted again? */
export function asksNotToBeContacted(text: string): boolean {
  return OPT_OUT.test(text);
}

const OUT_OF_HOURS = new Set(["booking", "form", "whatsapp"]);

export interface CaptureInput {
  /** null: no enquiry was sent, or it is too soon to judge. Then speed, quality and follow up are not measured. */
  enquiry: null | {
    /** Minutes from sending to a person's first reply. null: no person replied in the time allowed. */
    minutesToReply: number | null;
    /** The first person's reply came on the same calendar day the enquiry was sent. */
    sameDay: boolean;
    automaticAcknowledgement: boolean;
    /** null: the reply could not be assessed. */
    quality: { answered: boolean; nextStep: boolean } | null;
    followUps: number;
    /**
     * Set when the enquiry was sent while the business was shut. Then what is scored is whether anything USEFUL came
     * back, and how soon against when they next opened: a person, or an automatic reply that answered the question
     * or offered a booking. `band` null: nothing useful came at all.
     */
    outOfHours?: {
      band: "useful_within_15_minutes" | "useful_the_same_evening" | "within_the_first_working_hour" | "later_that_working_day" | "the_next_day" | null;
      /** What the useful reply was. */
      from: "a person" | "an automatic reply that answered the question or offered a booking" | null;
      minutes: number | null;
    };
  };
  /** Kinds of enquiry route the business publishes. null: not analysed. */
  routeKinds: string[] | null;
}

export interface CapturePart {
  name: "reply_speed" | "reply_quality" | "follow_up" | "routes" | "reviews_answered" | "social_activity";
  /** null: not measured. */
  points: number | null;
  max: number;
  note: string;
}

export interface Capture {
  /** null when nothing could be measured. */
  score: number | null;
  measured: number;
  of: number;
  parts: CapturePart[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How long, in plain words. */
export function sayMinutes(minutes: number): string {
  if (minutes < 60) return plural(Math.max(1, Math.round(minutes)), "minute");
  if (minutes < 48 * 60) return plural(Math.round(minutes / 6) / 10, "hour").replace(/\.0 /, " ");
  return plural(Math.round(minutes / (24 * 6)) / 10, "day");
}

export function captureScore(input: CaptureInput, settings: OutreachSettings): Capture {
  const w = settings.capture_weights;
  const parts: CapturePart[] = [];
  const e = input.enquiry;

  if (e) {
    const m = e.minutesToReply;
    const ack = e.automaticAcknowledgement ? " An automatic acknowledgement was received, which is not counted as a reply." : "";
    const limit = settings.reply_wait_hours * 60;
    const clock = m === null ? "No person replied in the time allowed" : `Clock time to a person's reply: ${sayMinutes(m)}`;
    const o = e.outOfHours;
    const OOH: Record<NonNullable<NonNullable<typeof o>["band"]>, string> = {
      useful_within_15_minutes: "within 15 minutes", useful_the_same_evening: "the same day, while they were still shut", within_the_first_working_hour: "by the end of their first hour open",
      later_that_working_day: "later on the day they next opened", the_next_day: "the day after they next opened",
    };
    const [points, note] = o
      // Sent while they were shut. Both things are said: what useful came back and when, and the clock time to a person.
      ? [o.band === null ? 0 : w.out_of_hours[o.band],
         `sent while they were shut. ${o.band === null ? "Nothing useful came back in the time allowed" : `Something useful came back ${OOH[o.band]} (${o.from}${o.minutes === null ? "" : `, ${sayMinutes(o.minutes)} after it was sent`})`}. ${clock}`]
      : m === null || m > Math.max(limit, 24 * 60) ? [0, `no reply from a person within ${settings.reply_wait_hours} hours`] :
      m <= 15 ? [w.within_15_minutes, `a person replied in ${sayMinutes(m)}`] :
      m <= 60 ? [w.within_1_hour, `a person replied in ${sayMinutes(m)}`] :
      m <= 240 ? [w.within_4_hours, `a person replied in ${sayMinutes(m)}`] :
      e.sameDay ? [w.same_day, `a person replied the same day, after ${sayMinutes(m)}`] :
      [w.within_24_hours, `a person replied after ${sayMinutes(m)}`];
    parts.push({ name: "reply_speed", points: points as number, max: w.within_15_minutes, note: `${note}.${ack}` });

    const qualityMax = w.answered_the_question + w.offered_a_next_step;
    if (m === null) parts.push({ name: "reply_quality", points: 0, max: qualityMax, note: "there was no reply to assess." });
    else if (e.quality === null) parts.push({ name: "reply_quality", points: null, max: qualityMax, note: "not measured: the reply could not be assessed." });
    else {
      parts.push({
        name: "reply_quality", max: qualityMax,
        points: (e.quality.answered ? w.answered_the_question : 0) + (e.quality.nextStep ? w.offered_a_next_step : 0),
        note: `${e.quality.answered ? "answered the question asked" : "did not answer the question asked"}; ${e.quality.nextStep ? "offered a next step" : "offered no next step"}.`,
      });
    }
    parts.push({ name: "follow_up", points: e.followUps > 0 ? w.followed_up : 0, max: w.followed_up, note: e.followUps > 0 ? `followed up ${plural(e.followUps, "time")} without being asked.` : "did not follow up." });
  } else {
    parts.push({ name: "reply_speed", points: null, max: w.within_15_minutes, note: "not measured: no enquiry has been tested." });
    parts.push({ name: "reply_quality", points: null, max: w.answered_the_question + w.offered_a_next_step, note: "not measured: no enquiry has been tested." });
    parts.push({ name: "follow_up", points: null, max: w.followed_up, note: "not measured: no enquiry has been tested." });
  }

  const routesMax = w.per_kind_of_route * w.route_kinds_counted + w.a_route_that_works_out_of_hours;
  if (input.routeKinds === null) parts.push({ name: "routes", points: null, max: routesMax, note: "not measured: the business has not been analysed." });
  else {
    const kinds = [...new Set(input.routeKinds)];
    const outOfHours = kinds.filter((k) => OUT_OF_HOURS.has(k));
    parts.push({
      name: "routes", max: routesMax,
      points: Math.min(kinds.length, w.route_kinds_counted) * w.per_kind_of_route + (outOfHours.length ? w.a_route_that_works_out_of_hours : 0),
      note: `${plural(kinds.length, "kind")} of enquiry route found${kinds.length ? ` (${kinds.join(", ")})` : ""}; ${outOfHours.length ? `${outOfHours.join(", ")} works out of hours` : "none that works out of hours"}.`,
    });
  }
  parts.push({ name: "reviews_answered", points: null, max: 10, note: "not measured: there is no reliable source yet." });
  parts.push({ name: "social_activity", points: null, max: 10, note: "not measured: there is no reliable source yet." });

  const measured = parts.filter((p) => p.points !== null);
  const got = measured.reduce((sum, p) => sum + (p.points as number), 0);
  const possible = measured.reduce((sum, p) => sum + p.max, 0);
  return { score: possible > 0 ? Math.round((got / possible) * 100) : null, measured: measured.length, of: parts.length, parts };
}

// ---- the estimated monthly leak --------------------------------------------

export type Leak =
  | { estimated: true; low: number; high: number; workings: string; /** Where the price came from. */ basis: "own_price" | "nearby_median" | "kind_median" }
  | { estimated: false; why: string };

const pounds = (n: number): string => `£${Math.round(n).toLocaleString("en-GB")}`;
const percent = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * A price for the service, from what OTHER businesses of the same kind have published, when the business publishes
 * none of its own. Each price is a real published figure with its source; only the middle of them is taken.
 * `amount: null`: there were not enough to take one.
 */
export type PriceBenchmark =
  | { amount: number; count: number; scope: "nearby" | "all_areas"; service: string; kind: string; area: string | null; sources: string[] }
  | { amount: null; service: string | null };

/** The fewest published prices a median is taken from. */
export const MIN_PRICES_FOR_MEDIAN = 2;

/** The median of some prices: the middle one, or the mean of the middle two. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Which named service a business's published price is for: its highest value service, matched against the kind's
 * list of services (and its default one). null when it cannot be told, and then the price is not compared.
 */
export function priceServiceOf(analysis: Record<string, unknown> | null | undefined, settings: OutreachSettings): string | null {
  const field = analysis?.highest_value_service as { value?: unknown } | string | undefined;
  const text = typeof field === "object" && field !== null && typeof field.value === "string" ? field.value.toLowerCase() : "";
  if (!text) return null;
  return namedServices(settings).find((service) => service.terms.some((term) => text.includes(term)))?.name ?? null;
}

/**
 * The benchmark for one business from the prices others of its kind published for the same service: those in its
 * own search area first, and when fewer than two of them publish one, those of the kind in every area searched.
 */
export function benchmarkFrom(
  self: { area: string | null; service: string | null }, others: { area: string | null; amount: number; source_url: string; service: string | null }[], settings: OutreachSettings,
): PriceBenchmark {
  if (!self.service) return { amount: null, service: null };
  const same = others.filter((o) => o.service === self.service && o.amount > 0);
  const nearby = self.area === null ? [] : same.filter((o) => o.area === self.area);
  const [found, scope] = nearby.length >= MIN_PRICES_FOR_MEDIAN ? [nearby, "nearby" as const] : [same, "all_areas" as const];
  // Cheapest first, so the sources are listed in the same order every time.
  const list = [...found].sort((a, b) => a.amount - b.amount || a.source_url.localeCompare(b.source_url));
  if (list.length < MIN_PRICES_FOR_MEDIAN) return { amount: null, service: self.service };
  // The LOWEST published price, not the middle one (owner, 18 Nov 2026): a rival's "dental implants" price can be a
  // full-mouth package at many times a single implant, and an estimate must never be inflated by that. The lowest
  // keeps a borrowed figure on the cautious side.
  return { amount: Math.min(...list.map((o) => o.amount)), count: list.length, scope, service: self.service, kind: settings.type.name, area: scope === "nearby" ? self.area : null, sources: list.map((o) => o.source_url) };
}

const listSources = (sources: string[]): string => {
  const shown = sources.slice(0, 5).join(", ");
  return sources.length > 5 ? `${shown} and ${sources.length - 5} more` : shown;
};

/**
 * An ESTIMATE of what a slow or missing reply costs a business each month, as a range, with the sum shown.
 * The price is the business's own published figure when it publishes one; when it does not, it is the median of
 * the prices other businesses of its kind publish for the same service (nearby first), which is said as such and
 * labelled as an assumption about this business. The reply is what the test measured. The other numbers are
 * assumptions from settings and are labelled as such wherever this appears. It is for Salekh's eyes on the card.
 * It is never to be stated to the business as a fact about them, and it is never given to the drafting model.
 * `benchmark` undefined: no other business's prices were looked at.
 */
export function estimateLeak(
  price: { amount: number; source_url: string } | null,
  enquiry: { minutesToReply: number | null; /** Sent while they were shut. `useful`: something useful came back before or as they opened. */ outOfHours?: { useful: boolean } } | null,
  settings: OutreachSettings,
  benchmark?: PriceBenchmark,
): Leak {
  if (!enquiry) return { estimated: false, why: "no enquiry has been tested, so there is nothing to base an estimate on" };
  const own = price && price.amount > 0 ? price : null;
  const borrowed = !own && benchmark && benchmark.amount !== null ? benchmark : null;
  if (!own && !borrowed) {
    if (!benchmark) return { estimated: false, why: "the business does not publish a price for its highest value service, so no estimate can be made" };
    return {
      estimated: false,
      why: benchmark.service
        ? `the business does not publish a price for ${benchmark.service}, and fewer than ${MIN_PRICES_FOR_MEDIAN} other businesses of its kind do, so no estimate can be made`
        : "the business does not publish a price for its highest value service, and which service to compare it on cannot be told, so no estimate can be made",
    };
  }
  const amount = own ? own.amount : (borrowed as { amount: number }).amount;
  const a = settings.leak_assumptions;
  const ooh = enquiry.outOfHours;
  if (ooh?.useful) return { estimated: false, why: "something useful came back while they were shut or as they opened, so no leak is estimated from this test" };
  if (!ooh && enquiry.minutesToReply !== null && enquiry.minutesToReply <= 240) return { estimated: false, why: "a person replied within four hours, so no leak is estimated from reply speed" };
  // A test sent out of hours speaks only for the enquiries that arrive out of hours: one more assumption, said as one.
  const share = ooh ? a.share_arriving_out_of_hours : { low: 1, high: 1 };
  const low = amount * a.enquiries_a_month.low * share.low * a.share_lost_to_a_slow_reply.low * a.share_that_would_have_bought.low;
  const high = amount * a.enquiries_a_month.high * share.high * a.share_lost_to_a_slow_reply.high * a.share_that_would_have_bought.high;
  const priceSaid = own
    ? `${pounds(own.amount)} (their published price, source: ${own.source_url})`
    : (() => {
        const b = borrowed as Extract<PriceBenchmark, { amount: number }>;
        const whose = b.scope === "nearby"
          ? `${b.count} nearby ${b.kind}${b.area ? ` in ${b.area}` : ""}`
          : `${b.count} ${b.kind} across every area searched`;
        return `${pounds(b.amount)}: the lowest published price among ${whose} for ${b.service}${b.scope === "nearby" ? "" : `, as fewer than ${MIN_PRICES_FOR_MEDIAN} nearby publish one`} (sources: ${listSources(b.sources)}). ` +
          "They publish no price of their own (ASSUMPTION: that they charge about the same)";
      })();
  return {
    estimated: true, low: Math.round(low), high: Math.round(high),
    basis: own ? "own_price" : (borrowed as Extract<PriceBenchmark, { amount: number }>).scope === "nearby" ? "nearby_median" : "kind_median",
    workings:
      `${priceSaid} × ${a.enquiries_a_month.low} to ${a.enquiries_a_month.high} enquiries a month (ASSUMPTION) ` +
      (ooh ? `× ${percent(share.low)} to ${percent(share.high)} arriving out of hours (ASSUMPTION; this test was sent out of hours) ` : "") +
      `× ${percent(a.share_lost_to_a_slow_reply.low)} to ${percent(a.share_lost_to_a_slow_reply.high)} lost to a slow or missing reply (ASSUMPTION) ` +
      `× ${percent(a.share_that_would_have_bought.low)} to ${percent(a.share_that_would_have_bought.high)} that would have bought (ASSUMPTION) = ${pounds(low)} to ${pounds(high)} a month`,
  };
}

// ---- what is stored about a test, and its score ------------------------------

export interface StoredReply {
  message_id: string;
  received_at: string;
  /** "bounce": a notice that the enquiry could not be delivered. The business never saw it, so it is not a result. */
  kind: "person" | "automatic" | "unclear" | "bounce";
  matched_by: "header" | "sender";
  /** PERSONAL DATA: the words of the reply. Lives here, on the prospect, and nowhere else. */
  text: string;
  answered?: { value: boolean; quote: string | null } | null;
  next_step?: { value: boolean; quote: string | null } | null;
  /** The sentence, in the reply's own words, that was read as a complaint about being contacted. Set only when both the phrase check and the reply reader agreed. */
  complaint_sentence?: string;
  /** Whether the reply's own words asked not to be contacted again. */
  opt_out?: boolean;
  /** The sentence in which the reply declined to answer by email and sent the person to the telephone, when it did. */
  told_to_call?: string;
}

export interface TestResult {
  enquiry_id: string;
  sent_at: string;
  replies: StoredReply[];
  opted_out?: boolean;
  /** Which part of the week it was sent in. */
  slot?: Slot;
  /** Whether the business was open when it was sent, by the hours Google shows. "unknown": none were shown. */
  opening_state?: "open" | "closed" | "unknown";
  /** When they next opened after it was sent. Absent when it was sent while they were open. */
  next_opening?: string;
  /** The earliest it may be scored. */
  score_after?: string;
}


/** The capture score of one business from what is stored about it. `tested` false: routes only. */
export function captureFor(test: TestResult | null, routeKinds: string[] | null, settings: OutreachSettings, timezone: string): Capture {
  if (!test) return captureScore({ enquiry: null, routeKinds }, settings);
  const sent = new Date(test.sent_at);
  const people = test.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at));
  const first = people[0];
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return captureScore({
    enquiry: {
      ...(sentOutOfHours(test) ? { outOfHours: usefulOutOfHours(test, timezone) } : {}),
      minutesToReply: first ? (new Date(first.received_at).getTime() - sent.getTime()) / 60000 : null,
      sameDay: first ? day(new Date(first.received_at)) === day(sent) : false,
      // A bare acknowledgement. An automatic reply that answered the question or offered a booking is not one.
      automaticAcknowledgement: test.replies.some((r) => r.kind === "automatic" && r.answered?.value !== true && r.next_step?.value !== true),
      quality: first ? (first.answered && first.next_step ? { answered: first.answered.value, nextStep: first.next_step.value } : null) : null,
      followUps: Math.max(0, people.length - 1),
    },
    routeKinds,
  }, settings);
}


// ---- opening hours -----------------------------------------------------------

/** Was the business open at this moment, by the hours it publishes? `periods` as Google Places gives them: day 0 is Sunday. */
export function openAt(periods: { open: { day: number; minutes: number }; close: { day: number; minutes: number } | null }[], when: Date, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const WEEK = 7 * 24 * 60;
  const at = day * 24 * 60 + Number(get("hour")) * 60 + Number(get("minute"));
  return periods.some((p) => {
    if (p.close === null) return true; // open round the clock
    const from = p.open.day * 24 * 60 + p.open.minutes;
    let to = p.close.day * 24 * 60 + p.close.minutes;
    if (to <= from) to += WEEK;
    return (at >= from && at < to) || (at + WEEK >= from && at + WEEK < to);
  });
}

// ---- replies that must stop sending ---------------------------------------------------

// Words of somebody who minds being written to. Deliberately NOT here: "complaint", "data protection", "GDPR", "ICO"
// and "do not contact" on their own, because a solicitor's or an adviser's standard footer has every one of them.
const COMPLAINT = /\b(spam|unsolicited|junk mail|harass\w*|report(ed|ing)? (you|this)|how did you get (my|our|this)|stop (emailing|contacting|messaging|writing)|legal action|cease and desist|take (me|us) off|not interested.{0,40}(again|further)|do not (contact|email|write to) (me|us)( again)?|remove (me|us) from)\b/i;

const QUOTE_STARTS = [
  /^\s*>/,                                                        // quoted lines
  /^\s*On .{5,200}(wrote|écrit|schrieb):?\s*$/i,                  // "On Tue, 17 Nov 2026 at 10:34, Salekh wrote:"
  /^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i,
  /^\s*(From|Sent|To|Subject|Date):\s.+/i,                         // the header block Outlook puts above what it quotes
  /^\s*_{5,}\s*$/,                                                 // the rule Outlook draws above it
];
const SIGN_OFF = /^\s*(kind regards|kindest regards|best regards|warm regards|regards|best wishes|many thanks|thanks|thank you|yours sincerely|yours faithfully|sincerely|cheers)[,.!]?\s*$/i;
const SIGNATURE = /^\s*--\s*$|^\s*sent from my \w+/i;
const FOOTER = /\b(confidential|intended (solely )?for the (addressee|recipient|person)|intended recipient|received this (e-?mail|message|communication) in error|disclaimer|privileged|regulated by|authorised and regulated|registered (in|office)|company (number|no\.?|registration)|vat (number|no\.?|reg)|virus(es)?|please consider the environment|complaints procedure|privacy (policy|notice)|data protection|unsubscribe)\b/i;

/**
 * A reply's OWN WORDS: what the person (or their system) wrote this time. Everything else is taken off before
 * anything is judged: the text they are replying to, quoted below; their signature; and the legal footer a firm
 * adds to every email it sends, which talks of confidentiality, complaints and not contacting people and has
 * nothing to do with this message.
 */
export function ownWords(text: string): string {
  const kept: string[] = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (const [i, line] of lines.entries()) {
    if (QUOTE_STARTS.some((start, n) => start.test(line) && (n !== 3 || /^\s*(From|Sent):/i.test(line) && lines.slice(i, i + 5).filter((l) => /^\s*(From|Sent|To|Subject|Date):/i.test(l)).length >= 2))) break;
    if (SIGNATURE.test(line)) break;
    kept.push(line);
    // The sign-off is kept; what follows it (a name, a job title, phone numbers, the footer) is not.
    if (SIGN_OFF.test(line) && kept.join(" ").trim().length > line.trim().length) break;
  }
  // A footer with no sign-off before it: paragraphs that read like one are dropped.
  return kept.join("\n").split(/\n\s*\n/).filter((paragraph) => !FOOTER.test(paragraph)).join("\n\n").trim();
}

/**
 * Do a reply's own words read as a complaint about being contacted? This is one of two things needed before
 * anything is stopped: the other is the reply reader agreeing, with a sentence that is really in those words.
 * "We do not give prices by email" and "please call us" are not complaints.
 */
export function readsAsComplaint(text: string): boolean {
  return COMPLAINT.test(text);
}

const TO_CALL = /\b(call|phone|telephone|ring|contact|speak to) (us|the office|our offices?|the practice|the clinic|the surgery|the team|reception|someone)\b|\b(need|have) to (call|phone|telephone|ring)\b|\b(by|over the) (phone|telephone)\b|\b(cannot|can't|do not|don't|unable to) (give|provide|quote|discuss) .{0,40}(by|over|via|on) e-?mail\b/i;
const A_REAL_STEP = /\b(book(ing)? (online|here|now|a)|appointment (on|at|for)|available (on|at|from)|we (can|could) (see|speak to|call) you|call you back|ring you back|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|\d{1,2}([:.]\d{2})? ?(am|pm))\b/i;

/** Does the reply send the person to the telephone? */
export function saysToCall(ownText: string): boolean {
  return TO_CALL.test(ownText);
}
/** Is this "next step" nothing more than "call us"? A time, a call back or a way to book makes it a real one. */
export function saysOnlyToCall(sentence: string): boolean {
  return TO_CALL.test(sentence) && !A_REAL_STEP.test(sentence);
}
/** The sentence that sends the person to the telephone, to quote. */
export function sentenceToCall(ownText: string): string {
  const sentences = ownText.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  return (sentences.find((sentence) => TO_CALL.test(sentence)) ?? "").trim().slice(0, 300);
}

/** Is this a notice that the enquiry could not be delivered? Judged from who sent it and its subject, never from its body. */
export function isBounce(from: string, subject: string): boolean {
  return /^(mailer-daemon|postmaster)@/i.test(from.trim()) || /\b(delivery status notification|undeliver(ed|able)|delivery (has )?failed|mail delivery (failed|subsystem)|returned mail|address not found|message not delivered)\b/i.test(subject);
}

// ---- when an enquiry may be sent ----------------------------------------------------------

export type Slot = "in_hours" | "evening" | "weekend";
export const SLOTS: readonly Slot[] = ["in_hours", "evening", "weekend"];
export const SLOT_NAME: Record<Slot, string> = { in_hours: "in working hours", evening: "on a weekday evening", weekend: "at the weekend" };

type Hours = Pick<OutreachSettings, "enquiry_send_days" | "enquiry_send_from" | "enquiry_send_until" | "enquiry_no_send_dates" | "working_days" | "working_hours_from" | "working_hours_until" | "non_working_dates">;

/** A moment as the tenant's own clock shows it. */
function local(when: Date, timezone: string): { day: number; date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1, date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

const isWorkingDay = (l: { day: number; date: string }, settings: Hours) => settings.working_days.includes(l.day) && !settings.non_working_dates.includes(l.date);

/** Is this moment inside the sending hours, on a sending day, and not a day set aside? All in the tenant's own time zone. */
export function withinSendingHours(when: Date, timezone: string, settings: Hours): boolean {
  const l = local(when, timezone);
  return settings.enquiry_send_days.includes(l.day) && !settings.enquiry_no_send_dates.includes(l.date) && l.time >= settings.enquiry_send_from && l.time < settings.enquiry_send_until;
}

/**
 * Which slot this moment falls in, or null when nothing is sent now (the small hours, an early weekday morning, a
 * weekend evening, a day set aside).
 */
export function slotAt(when: Date, timezone: string, settings: Hours): Slot | null {
  if (!withinSendingHours(when, timezone, settings)) return null;
  const l = local(when, timezone);
  const inDay = l.time >= settings.working_hours_from && l.time < settings.working_hours_until;
  if (isWorkingDay(l, settings)) return inDay ? "in_hours" : l.time >= settings.working_hours_until ? "evening" : null;
  return inDay ? "weekend" : null;
}

/** Is this a moment in the working day, by the settings (used when a business shows no opening hours of its own)? */
function inWorkingHours(when: Date, timezone: string, settings: Hours): boolean {
  const l = local(when, timezone);
  return isWorkingDay(l, settings) && l.time >= settings.working_hours_from && l.time < settings.working_hours_until;
}

const STEP_MS = 15 * 60 * 1000;

/** When a business next opens after a moment: by the hours Google shows for it when there are any, otherwise by the working day in the settings. */
export function nextOpening(after: Date, timezone: string, periods: Parameters<typeof openAt>[0] | null, settings: Hours): Date | null {
  const isOpen = (t: Date) => (periods && periods.length > 0 ? openAt(periods, t, timezone) : inWorkingHours(t, timezone, settings));
  // Looked for a quarter of an hour at a time, from the next quarter hour, for up to ten days.
  let t = new Date(Math.ceil((after.getTime() + 1) / STEP_MS) * STEP_MS);
  for (let i = 0; i < 10 * 24 * 4; i += 1, t = new Date(t.getTime() + STEP_MS)) if (isOpen(t)) return t;
  return null;
}

/** The end of the next working day strictly after a moment's own day. */
function endOfNextWorkingDay(after: Date, timezone: string, settings: Hours): Date | null {
  const start = local(after, timezone).date;
  let t = new Date(Math.ceil((after.getTime() + 1) / STEP_MS) * STEP_MS);
  let last: Date | null = null;
  for (let i = 0; i < 10 * 24 * 4; i += 1, t = new Date(t.getTime() + STEP_MS)) {
    const l = local(t, timezone);
    if (l.date === start) continue;
    if (inWorkingHours(t, timezone, settings)) last = t;
    else if (last) return new Date(last.getTime() + STEP_MS);
  }
  return null;
}

/**
 * The earliest an enquiry may be scored: 24 hours (the setting) after it was sent, or, for one sent in the evening
 * or at the weekend, the end of the next working day if that is later. A business cannot be marked down for not
 * answering before it has had a working day to.
 */
export function scoreAfter(sent: Date, slot: Slot | null, timezone: string, settings: Hours & Pick<OutreachSettings, "reply_wait_hours">): Date {
  const plain = new Date(sent.getTime() + settings.reply_wait_hours * 60 * 60 * 1000);
  if (slot !== "evening" && slot !== "weekend") return plain;
  const end = endOfNextWorkingDay(sent, timezone, settings);
  return end && end.getTime() > plain.getTime() ? end : plain;
}

/** Was this enquiry sent while the business was shut? By its own hours when Google showed any, otherwise by the slot. */
export function sentOutOfHours(test: Pick<TestResult, "slot" | "opening_state">): boolean {
  if (test.opening_state === "closed") return true;
  if (test.opening_state === "open") return false;
  return test.slot === "evening" || test.slot === "weekend";
}

/** For an enquiry sent out of hours: the first useful thing that came back, and where it falls against when they next opened. */
export function usefulOutOfHours(test: TestResult, timezone: string): NonNullable<NonNullable<CaptureInput["enquiry"]>["outOfHours"]> {
  const sent = new Date(test.sent_at).getTime();
  const useful = test.replies
    .filter((r) => r.kind === "person" || (r.kind === "automatic" && (r.answered?.value === true || r.next_step?.value === true)))
    .sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
  if (!useful) return { band: null, from: null, minutes: null };
  const at = new Date(useful.received_at).getTime();
  const minutes = (at - sent) / 60000;
  const from = useful.kind === "person" ? ("a person" as const) : ("an automatic reply that answered the question or offered a booking" as const);
  // With no record of when they next opened, the moment of sending stands in for it.
  const opened = test.next_opening ? new Date(test.next_opening).getTime() : sent;
  const sameDay = (a: number, b: number) => local(new Date(a), timezone).date === local(new Date(b), timezone).date;
  const band =
    minutes <= 15 ? "useful_within_15_minutes" :
    at < opened && sameDay(at, sent) ? "useful_the_same_evening" :
    at <= opened + 60 * 60 * 1000 ? "within_the_first_working_hour" :
    sameDay(at, opened) ? "later_that_working_day" :
    at <= opened + 36 * 60 * 60 * 1000 ? "the_next_day" : null;
  return band === null ? { band: null, from: null, minutes: null } : { band, from, minutes };
}


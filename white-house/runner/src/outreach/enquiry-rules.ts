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

/** What is wrong with a drafted enquiry, in fixed words. Empty: it may be proposed. */
export function lintEnquiry(draft: EnquiryDraft, settings: OutreachSettings): string[] {
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
    const [points, note] =
      m === null || m > Math.max(limit, 24 * 60) ? [0, `no reply from a person within ${settings.reply_wait_hours} hours`] :
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
  | { estimated: true; low: number; high: number; workings: string }
  | { estimated: false; why: string };

const pounds = (n: number): string => `£${Math.round(n).toLocaleString("en-GB")}`;
const percent = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * An ESTIMATE of what a slow or missing reply costs a business each month, as a range, with the sum shown.
 * The price is the business's own published figure and the reply is what the test measured. The other three
 * numbers are assumptions from settings and are labelled as such wherever this appears. It is for Salekh's
 * eyes on the card. It is never to be stated to the business as a fact about them.
 */
export function estimateLeak(
  price: { amount: number; source_url: string } | null,
  enquiry: { minutesToReply: number | null } | null,
  settings: OutreachSettings,
): Leak {
  if (!enquiry) return { estimated: false, why: "no enquiry has been tested, so there is nothing to base an estimate on" };
  if (!price || !(price.amount > 0)) return { estimated: false, why: "the business does not publish a price for its highest value service, so no estimate can be made" };
  if (enquiry.minutesToReply !== null && enquiry.minutesToReply <= 240) return { estimated: false, why: "a person replied within four hours, so no leak is estimated from reply speed" };
  const a = settings.leak_assumptions;
  const low = price.amount * a.enquiries_a_month.low * a.share_lost_to_a_slow_reply.low * a.share_that_would_have_bought.low;
  const high = price.amount * a.enquiries_a_month.high * a.share_lost_to_a_slow_reply.high * a.share_that_would_have_bought.high;
  return {
    estimated: true, low: Math.round(low), high: Math.round(high),
    workings:
      `${pounds(price.amount)} (their published price, source: ${price.source_url}) × ${a.enquiries_a_month.low} to ${a.enquiries_a_month.high} enquiries a month (ASSUMPTION) ` +
      `× ${percent(a.share_lost_to_a_slow_reply.low)} to ${percent(a.share_lost_to_a_slow_reply.high)} lost to a slow or missing reply (ASSUMPTION) ` +
      `× ${percent(a.share_that_would_have_bought.low)} to ${percent(a.share_that_would_have_bought.high)} that would have bought (ASSUMPTION) = ${pounds(low)} to ${pounds(high)} a month`,
  };
}

// ---- what is stored about a test, and its score ------------------------------

export interface StoredReply {
  message_id: string;
  received_at: string;
  kind: "person" | "automatic" | "unclear";
  matched_by: "header" | "sender";
  /** PERSONAL DATA: the words of the reply. Lives here, on the prospect, and nowhere else. */
  text: string;
  answered?: { value: boolean; quote: string | null } | null;
  next_step?: { value: boolean; quote: string | null } | null;
}

export interface TestResult {
  enquiry_id: string;
  sent_at: string;
  replies: StoredReply[];
  opted_out?: boolean;
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
      minutesToReply: first ? (new Date(first.received_at).getTime() - sent.getTime()) / 60000 : null,
      sameDay: first ? day(new Date(first.received_at)) === day(sent) : false,
      automaticAcknowledgement: test.replies.some((r) => r.kind === "automatic"),
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

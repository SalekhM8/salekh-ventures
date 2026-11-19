import { createHash } from "node:crypto";

/**
 * The keys that keep the master list to one row per business. All of this is
 * plain code: the model's spelling of a name or an address is never trusted
 * to tell two businesses apart.
 */

/** Hosts where a page belongs to a platform, not to the business. They are not a key. */
const SHARED_HOSTS = [
  "facebook.com", "fb.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "linkedin.com", "youtube.com",
  "google.com", "google.co.uk", "g.page", "goo.gl", "maps.app.goo.gl", "linktr.ee", "yell.com", "trustpilot.com",
  "indeed.com", "indeed.co.uk", "reed.co.uk", "totaljobs.com", "nhs.uk", "wixsite.com", "wordpress.com",
  "company-information.service.gov.uk", "whatsapp.com", "wa.me", "booksy.com", "fresha.com", "treatwell.co.uk",
];

function hostOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

const isShared = (host: string): boolean => SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`));

/** A website reduced to its host: lower case, no www. null when it is not the business's own site. */
export function domainKey(website: unknown): string | null {
  const host = hostOf(website)?.replace(/^www\./, "") ?? null;
  return host === null || isShared(host) ? null : host;
}

/** The host of any address, shared platforms included. For checking where a fact came from. */
export function hostKey(address: unknown): string | null {
  return hostOf(address)?.replace(/^www\./, "") ?? null;
}

/** A UK postcode with no spaces, upper case. null when it does not look like one. */
export function postcodeKey(postcode: unknown): string | null {
  if (typeof postcode !== "string") return null;
  const key = postcode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(key) ? key : null;
}

const LEGAL_WORDS = new Set(["the", "ltd", "limited", "llp", "plc", "co", "company", "uk", "t/a", "ta"]);
/** Words that say what kind of place it is, not which one. Ignored when judging a near match. */
const GENERIC_WORDS = new Set([
  "and", "dental", "dentist", "dentists", "dentistry", "clinic", "clinics", "practice", "care", "centre", "center", "surgery",
  "aesthetics", "aesthetic", "skin", "cosmetic", "cosmetics", "medical", "studio", "group", "services", "private", "of", "at",
]);

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !LEGAL_WORDS.has(word));
}

/** A name with case, punctuation and legal endings taken out. */
export function nameKey(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const key = tokens(name).join(" ");
  return key || null;
}

/** sha256 of the normalised name and postcode. Survives a purge, so a purged business is still recognised. */
export function namePostcodeHash(name: unknown, postcode: unknown): string | null {
  const n = nameKey(name);
  const p = postcodeKey(postcode);
  return n && p ? createHash("sha256").update(`${n}|${p}`).digest("hex") : null;
}

/**
 * Two names at the same postcode are taken as one business when, with the
 * generic words removed, what is left is the same.
 * "Fixture Smile Dental" and "The Fixture Smile Dental Clinic" match.
 */
export function namesNearlyMatch(a: string, b: string): boolean {
  const distinct = (name: string) => [...new Set(tokens(name).filter((word) => !GENERIC_WORDS.has(word)))].sort().join(" ");
  const left = distinct(a);
  return left.length > 0 && left === distinct(b);
}

/** The words in a name that say which business it is, not what kind. */
export function distinctiveWords(name: string): string[] {
  return [...new Set(tokens(name).filter((word) => !GENERIC_WORDS.has(word) && word.length > 3))];
}

/** A company number as Companies House writes it: eight characters, upper case. null when it is not one. */
export function companyNumberKey(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).toUpperCase().replace(/\s+/g, "");
  if (/^\d{6,8}$/.test(text)) return text.padStart(8, "0");
  return /^[A-Z]{2}\d{6}$/.test(text) ? text : null;
}

const LINKEDIN_PROFILE = /(^|[^a-z0-9-])([a-z0-9-]+\.)*linkedin\.com\/(in|pub)\//i;

/**
 * Addresses no agent may fetch, whatever its instructions say. Today that is
 * LinkedIn profile pages (hard rule: no scraping LinkedIn profiles), including
 * when the profile address is wrapped inside another address.
 */
export function isBlockedAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  let text = address;
  for (let i = 0; i < 3; i += 1) {
    if (LINKEDIN_PROFILE.test(text)) return true;
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  return LINKEDIN_PROFILE.test(text);
}

// ---- opening hours, short --------------------------------------------------

const DAYS = [["monday", "Mon"], ["tuesday", "Tue"], ["wednesday", "Wed"], ["thursday", "Thu"], ["friday", "Fri"], ["saturday", "Sat"], ["sunday", "Sun"]] as const;
export const NO_HOURS = "Hours not listed";
const SHORT_LIMIT = 48;

/** "9:00 AM – 5:30 PM" → "9–5:30"; "09:00–17:00" → "9–17"; "Closed" → "closed". */
function shortTimes(text: string): string {
  const t = text.trim();
  if (/^closed$/i.test(t)) return "closed";
  if (/open 24 hours/i.test(t)) return "24 hours";
  return t
    .replace(/\s*[–—-]\s*/g, "–")
    .replace(/\s*(am|pm)\b/gi, "")
    .replace(/:00\b/g, "")
    .replace(/(^|[–\s,])0(\d)/g, "$1$2")
    .replace(/\s*,\s*/g, " & ");
}

/**
 * Opening hours in a few words for a table cell: consecutive days with the same hours are joined, as
 * "Mon–Fri 9–5, Sat 10–2, Sun closed". Google's "Monday: 9:00 AM – 5:00 PM; Tuesday: …" is read day by day;
 * anything else is kept if short and cut at a word if not. Nothing, or "not found": "Hours not listed".
 */
export function shortHours(value: unknown): string {
  if (typeof value !== "string") return NO_HOURS;
  const text = value.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || /^not found$/i.test(text)) return NO_HOURS;
  const parts = text.split(/\s*;\s*/).filter(Boolean);
  const days = parts.map((p) => {
    const m = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(p);
    const day = m ? DAYS.findIndex(([long]) => long === (m[1] as string).toLowerCase()) : -1;
    return day >= 0 && m ? { day, hours: shortTimes(m[2] as string) } : null;
  });
  if (days.length > 0 && days.every((d) => d !== null)) {
    const groups: { from: number; to: number; hours: string }[] = [];
    for (const d of days as { day: number; hours: string }[]) {
      const last = groups[groups.length - 1];
      if (last && last.hours === d.hours && d.day === last.to + 1) last.to = d.day;
      else groups.push({ from: d.day, to: d.day, hours: d.hours });
    }
    const name = (i: number) => DAYS[i]?.[1] ?? "";
    return groups.map((g) => `${g.from === g.to ? name(g.from) : `${name(g.from)}–${name(g.to)}`} ${g.hours}`).join(", ");
  }
  if (text.length <= SHORT_LIMIT) return text;
  const cut = text.slice(0, SHORT_LIMIT);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : SHORT_LIMIT).replace(/[,;:\s]+$/, "")}…`;
}

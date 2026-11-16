/**
 * What plain code can read off a page without a model: the ways to get in
 * touch, a company number, a postcode. The model is not asked for any of
 * these (rule 2: if a rule can decide it, no model runs).
 *
 * The text is whatever a public page said. It is data. Nothing here acts on it.
 */

export interface Page {
  url: string;
  text: string;
}

export interface Route {
  kind: "email" | "phone" | "whatsapp" | "instagram" | "facebook" | "form";
  value: string;
  source_url: string;
}

export interface Extracted {
  routes: Route[];
  companyNumber: { value: string; source_url: string } | null;
  postcode: { value: string; source_url: string } | null;
  websiteBuiltBy: { value: string; source_url: string } | null;
}

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const NOT_AN_ADDRESS = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(sentry|example|wixpress|2x)\b|^(noreply|no-reply|donotreply)@/i;
const UK_PHONE = /(?:\+44\s?\(?0?\)?\s?|\b0)(?:\d[\s-]?){9,10}\b/g;
const WHATSAPP = /(?:https?:\/\/)?(?:wa\.me\/\+?\d{8,15}|api\.whatsapp\.com\/send\?phone=\+?\d{8,15}|chat\.whatsapp\.com\/[A-Za-z0-9]+)/gi;
const INSTAGRAM = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})\/?/gi;
const FACEBOOK = /(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/([A-Za-z0-9.\-]{3,60})\/?/gi;
const FORM = /\b(contact form|enquiry form|inquiry form|booking form|send (us )?(a|your) message|request a (call ?back|callback|consultation)|book (a |an )?(free )?(consultation|appointment) online|your (name|email|message)\s*\*)/i;
const COMPANY_NUMBER = /\b(?:company|registered|registration)\s*(?:no|number|reg(?:istration)?(?:\s*no|\s*number)?)\.?\s*[:#]?\s*((?:[A-Z]{2})?\d{6,8})\b/i;
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/;
const BUILT_BY = /\b(?:website|site|web design|designed|built|developed|powered)\s+by\s+/i;
const AGENCY_NAME = /^([A-Z][A-Za-z0-9&' -]{2,40}?)(?=[.,|\n]|\s{2}|$)/;
const NOT_A_PROFILE = new Set(["p", "reel", "reels", "explore", "accounts", "stories", "tv", "sharer", "share", "tr", "plugins", "dialog", "login", "policies", "privacy", "help", "pages", "groups", "events", "watch"]);

function phoneKey(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^44(0)?/, "0");
  return digits.length === 11 || digits.length === 10 ? digits : "";
}

/** Read the contact routes and identifiers off a business's own pages, each with the page it came from. */
export function extractFromPages(pages: Page[]): Extracted {
  const routes: Route[] = [];
  const seen = new Set<string>();
  const add = (kind: Route["kind"], value: string, source_url: string, key = value.toLowerCase()) => {
    const id = `${kind}|${key}`;
    if (seen.has(id) || routes.filter((r) => r.kind === kind).length >= 5) return;
    seen.add(id);
    routes.push({ kind, value, source_url });
  };
  let companyNumber: Extracted["companyNumber"] = null;
  let postcode: Extracted["postcode"] = null;
  let websiteBuiltBy: Extracted["websiteBuiltBy"] = null;

  for (const page of pages) {
    const text = page.text;
    for (const m of text.match(EMAIL) ?? []) if (!NOT_AN_ADDRESS.test(m)) add("email", m.toLowerCase(), page.url);
    for (const m of text.match(UK_PHONE) ?? []) {
      const key = phoneKey(m);
      if (key) add("phone", m.trim().replace(/\s+/g, " "), page.url, key);
    }
    for (const m of text.match(WHATSAPP) ?? []) add("whatsapp", m.startsWith("http") ? m : `https://${m}`, page.url);
    for (const m of text.matchAll(INSTAGRAM)) if (!NOT_A_PROFILE.has((m[1] as string).toLowerCase())) add("instagram", `https://instagram.com/${(m[1] as string).replace(/\.+$/, "")}`, page.url);
    for (const m of text.matchAll(FACEBOOK)) if (!NOT_A_PROFILE.has((m[1] as string).toLowerCase())) add("facebook", `https://facebook.com/${(m[1] as string).replace(/\.+$/, "")}`, page.url);
    if (FORM.test(text)) add("form", page.url, page.url, "form");
    if (!companyNumber) {
      const m = COMPANY_NUMBER.exec(text);
      if (m) companyNumber = { value: m[1] as string, source_url: page.url };
    }
    if (!postcode) {
      const m = POSTCODE.exec(text);
      if (m) postcode = { value: `${m[1]} ${m[2]}`, source_url: page.url };
    }
    if (!websiteBuiltBy) {
      const credit = BUILT_BY.exec(text);
      const m = credit ? AGENCY_NAME.exec(text.slice(credit.index + credit[0].length)) : null;
      if (m) websiteBuiltBy = { value: (m[1] as string).trim(), source_url: page.url };
    }
  }
  const order: Route["kind"][] = ["email", "phone", "whatsapp", "instagram", "facebook", "form"];
  routes.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { routes, companyNumber, postcode, websiteBuiltBy };
}

const WANTED: { kind: string; test: RegExp }[] = [
  { kind: "contact", test: /contact|find-us|get-in-touch|enquir/i },
  { kind: "about", test: /about|team|meet|our-story|who-we-are|staff/i },
  { kind: "services", test: /treatment|service|price|fee|cost/i },
];

/**
 * From a list of candidate addresses on the business's own host, pick at most
 * one each of: contact, about or team, treatments or prices.
 */
export function pickPages(candidates: string[], host: string, alreadyHave: string[]): string[] {
  const have = new Set(alreadyHave.map((u) => u.replace(/\/+$/, "").toLowerCase()));
  const picked: string[] = [];
  for (const want of WANTED) {
    const hit = candidates.find((candidate) => {
      try {
        const url = new URL(candidate);
        const sameHost = url.hostname.toLowerCase().replace(/^www\./, "") === host;
        const key = candidate.replace(/\/+$/, "").toLowerCase();
        return sameHost && want.test.test(url.pathname) && !have.has(key) && !picked.includes(candidate);
      } catch {
        return false;
      }
    });
    if (hit) picked.push(hit);
  }
  return picked;
}

/** Addresses written out in a page's text. Clean text keeps few of them, so this is a help, not the plan. */
export function linksIn(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)<>"'\]]+/gi) ?? [])].map((u) => u.replace(/[.,;:]+$/, ""));
}

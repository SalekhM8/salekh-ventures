import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";
import { Parser } from "htmlparser2";
import { ControlError } from "../errors.js";

/**
 * Reading a business's own public web pages directly, by plain code. No
 * outside service stands between the runner and the site, so reading does
 * not hang off anybody's free allowance.
 *
 * What it will and will not do:
 *   - GET over http or https, to the standard ports, and nothing else.
 *   - It never connects to a private, loopback or link-local address. The
 *     check is made on the address the connection is actually opened to (the
 *     socket's own lookup), for the first request and for every redirect, so
 *     a name that resolves one way when checked and another when used gets
 *     nowhere. This is why node:http is used here and not fetch: fetch gives
 *     no way to pin the address that was checked.
 *   - At most 5 redirects, 15 seconds, 2 MB, and only text/html or text/plain.
 *   - It says who it is: a generic client name, no personal details, and it
 *     does not pretend to be a browser.
 *   - It obeys robots.txt (the caller asks `allowedByRobots` first).
 *   - A bot check, a login wall or a refusal is recorded as "blocked". It is
 *     never retried and nothing tries to get past it.
 *
 * Everything it returns is untrusted data written by strangers.
 */

export const DIRECT_READ_AGENT = "business-page-reader";
export const DIRECT_READ_USER_AGENT = `${DIRECT_READ_AGENT}/1.0 (reads a business's own public pages; obeys robots.txt)`;

export type DirectReadCode =
  | "direct_disallowed"       // robots.txt says no
  | "direct_blocked"          // a bot check, a login, a refusal: left alone
  | "direct_refused_address"  // not http(s), a private address, an odd port
  | "direct_not_text"         // not text/html or text/plain
  | "direct_too_large"
  | "direct_timeout"
  | "direct_failed";          // anything else: unreachable, a server error, too many redirects

export class DirectReadError extends ControlError {
  constructor(code: DirectReadCode, message: string) {
    super(code, message);
    this.name = "DirectReadError";
  }
}

// ---- which addresses may be connected to --------------------------------------

const refused = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) refused.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) refused.addSubnet(net, bits, "ipv6");

/** True only for an address on the public internet. Private, loopback, link-local, carrier, documentation and multicast ranges are all refused. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !refused.check(address, "ipv4");
  if (kind !== 6) return false;
  // An IPv4 address written inside an IPv6 one is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return isPublicAddress(mapped[1] as string);
  if (/^::ffff:/i.test(address)) return false;
  return !refused.check(address, "ipv6");
}

// ---- one GET ----------------------------------------------------------------------

export interface DirectReadOptions {
  /** Which addresses may be connected to. Tests pass one that lets 127.0.0.1 through; nothing else should. */
  allowAddress?: (address: string) => boolean;
  /** Which ports may be connected to. Default: 80 and 443 only. */
  allowPort?: (port: number) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** The least time between two requests to one host. */
  minHostGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Characters of page text kept. */
  textChars?: number;
}

interface Fetched {
  url: string;
  status: number;
  type: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface DirectPage {
  url: string;
  title: string | null;
  text: string;
}

export interface DirectReader {
  /** Does robots.txt let us read this address? `robots` is that host's robots.txt, or null if it has none. */
  allowedByRobots(url: string, robots: string | null): boolean;
  /** That host's robots.txt. null: it has none. Throws `direct_blocked` when the site refuses even that, which is taken as a no. */
  robots(origin: string): Promise<string | null>;
  /** One page, as text. Throws a DirectReadError saying why not. */
  read(url: string): Promise<DirectPage>;
  /** Addresses listed in the host's /sitemap.xml that are on that host. Empty when there is none. */
  sitemap(origin: string): Promise<string[]>;
}

const CHALLENGE = /just a moment\.\.\.|cf-chl|cf_chl|challenge-platform|attention required|verify you are (a )?human|are you a robot|captcha|ddos protection by|px-captcha|datadome|access denied|unusual traffic|enable javascript and cookies to continue/i;

export function createDirectReader(options: DirectReadOptions = {}): DirectReader {
  const allowAddress = options.allowAddress ?? isPublicAddress;
  const allowPort = options.allowPort ?? ((port: number) => port === 80 || port === 443);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const minHostGapMs = options.minHostGapMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const textChars = options.textChars ?? 20_000;
  const lastAsked = new Map<string, number>();

  /** The socket's own lookup: every address the name gives must be allowed, and the one connected to is one of those checked. */
  const checkedLookup = (hostname: string, opts: any, callback: (err: Error | null, address?: any, family?: number) => void): void => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) return callback(err ?? new Error("no address"));
      if (!addresses.every((a) => allowAddress(a.address))) return callback(new DirectReadError("direct_refused_address", "that address is not on the public internet"));
      if (opts?.all) return callback(null, addresses);
      const first = addresses[0] as { address: string; family: number };
      callback(null, first.address, first.family);
    });
  };

  function once(target: URL, accept: string[], deadline: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; type: string; body: string }> {
    return new Promise((resolve, reject) => {
      const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
      if (target.protocol !== "http:" && target.protocol !== "https:") return reject(new DirectReadError("direct_refused_address", "only http and https are read"));
      if (target.username || target.password) return reject(new DirectReadError("direct_refused_address", "an address with a login in it is not read"));
      if (!allowPort(port)) return reject(new DirectReadError("direct_refused_address", "that port is not read"));
      // A literal address never reaches the lookup, so it is checked here.
      const literal = target.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) && !allowAddress(literal)) return reject(new DirectReadError("direct_refused_address", "that address is not on the public internet"));
      const left = deadline - Date.now();
      if (left <= 0) return reject(new DirectReadError("direct_timeout", "the site took too long"));
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(err instanceof DirectReadError ? err : new DirectReadError("direct_failed", "the site could not be read"));
      };
      const req = (target.protocol === "https:" ? https : http).request(target, {
        method: "GET", lookup: checkedLookup as any, agent: false,
        headers: { "user-agent": DIRECT_READ_USER_AGENT, accept: accept.join(", "), "accept-encoding": "gzip, deflate, br", "accept-language": "en-GB, en;q=0.8" },
      }, (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream = encoding === "gzip" ? res.pipe(zlib.createGunzip()) : encoding === "deflate" ? res.pipe(zlib.createInflate()) : encoding === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        // A page of the wrong kind is not downloaded. (A refusal or an error is read, briefly, to see whether it is a bot check.)
        if (status >= 200 && status < 300 && !accept.includes(type)) return fail(new DirectReadError("direct_not_text", "that address is not a web page"));
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return fail(new DirectReadError("direct_too_large", "the page is too large"));
          chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status, headers: res.headers, type, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      const timer = setTimeout(() => fail(new DirectReadError("direct_timeout", "the site took too long")), left);
      req.on("error", fail);
      req.end();
    });
  }

  /** GET with redirects followed by hand, each one checked like the first. One deadline covers the lot. */
  async function get(address: string, accept: string[]): Promise<Fetched> {
    let target: URL;
    try {
      target = new URL(address);
    } catch {
      throw new DirectReadError("direct_refused_address", "not a web address");
    }
    const deadline = Date.now() + timeoutMs;
    for (let hop = 0; hop <= 5; hop += 1) {
      const host = target.host.toLowerCase();
      const wait = minHostGapMs - (Date.now() - (lastAsked.get(host) ?? 0));
      if (lastAsked.has(host) && wait > 0) await sleep(wait);
      lastAsked.set(host, Date.now());
      const res = await once(target, accept, deadline);
      if (res.status >= 300 && res.status < 400 && typeof res.headers.location === "string") {
        try {
          target = new URL(res.headers.location, target);
        } catch {
          throw new DirectReadError("direct_failed", "the site sent a redirect that is not an address");
        }
        continue;
      }
      return { url: target.toString(), ...res };
    }
    throw new DirectReadError("direct_failed", "too many redirects");
  }

  /** A refusal, a login wall or a bot check. Seen once and left alone. */
  const isBlocked = (res: Fetched): boolean =>
    res.status === 401 || res.status === 403 || res.status === 407 || res.status === 429 || res.headers["cf-mitigated"] !== undefined ||
    ((res.status === 503 || res.status === 200) && CHALLENGE.test(res.body.slice(0, 20_000)) && toText(res.body, res.url, 2000).text.length < 600);

  return {
    allowedByRobots: (url, robots) => robotsAllow(robots, url, DIRECT_READ_AGENT),
    async robots(origin) {
      const res = await get(new URL("/robots.txt", origin).toString(), ["text/plain", "text/html"]);
      if (isBlocked(res)) throw new DirectReadError("direct_blocked", "the site refused the request for its robots.txt");
      // A server error is not a yes: until the site can say, it is not read.
      if (res.status >= 500) throw new DirectReadError("direct_disallowed", "the site's robots.txt answered with an error, so the site was not read");
      // No robots.txt (or a page of HTML where one would be): nothing is disallowed.
      return res.status === 200 && res.type === "text/plain" ? res.body.slice(0, 500_000) : null;
    },
    async read(url) {
      const res = await get(url, ["text/html", "text/plain"]);
      if (isBlocked(res)) throw new DirectReadError("direct_blocked", "the site showed a bot check, a login or a refusal");
      if (res.status < 200 || res.status >= 300) throw new DirectReadError("direct_failed", `the site answered ${res.status}`);
      if (res.type === "text/plain") return { url: res.url, title: null, text: res.body.slice(0, textChars) };
      return { url: res.url, ...toText(res.body, res.url, textChars) };
    },
    async sitemap(origin) {
      const res = await get(new URL("/sitemap.xml", origin).toString(), ["application/xml", "text/xml", "text/plain"]).catch(() => null);
      if (!res || res.status !== 200) return [];
      const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
      const found: string[] = [];
      for (const m of res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        try {
          const loc = new URL((m[1] as string).replace(/&amp;/g, "&"));
          if (loc.hostname.toLowerCase().replace(/^www\./, "") === host && !/\.xml(\.gz)?$/i.test(loc.pathname)) found.push(loc.toString());
        } catch { /* not an address */ }
        if (found.length >= 500) break;
      }
      return found;
    },
  };
}

// ---- robots.txt -----------------------------------------------------------------------

/** Does this robots.txt let `agent` read `url`? The group naming the agent is used if there is one, otherwise the group for `*`. The longest matching rule wins; a tie goes to Allow. */
export function robotsAllow(robots: string | null, url: string, agent: string): boolean {
  if (!robots) return true;
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const at = line.indexOf(":");
    if (at < 1) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: field === "allow", path: value });
    } else lastWasAgent = false;
  }
  const name = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  const rules = (mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let target: URL;
  try { target = new URL(url); } catch { return false; }
  const path = `${target.pathname}${target.search}`;
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    const pattern = new RegExp(`^${rule.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    if (!pattern.test(path)) continue;
    if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) best = { allow: rule.allow, length: rule.path.length };
  }
  return best ? best.allow : true;
}

// ---- HTML to text -------------------------------------------------------------------------

const SKIP = new Set(["script", "style", "noscript", "svg", "template", "iframe", "canvas", "object", "select"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "li", "ul", "ol", "tr", "table", "br", "address", "blockquote", "dl", "dt", "dd", "figure", "figcaption", "aside", "form", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * A page as plain text for the analysis: what a visitor reads, without scripts, styles or the menu's words.
 * Kept on purpose: headings; every email address and phone number the page links to; JSON-LD blocks (they
 * often hold the address and the opening hours); and, last, the page's links to other pages of the same
 * site, each with its full address, so the contact, prices, team and booking pages can be found without a search.
 */
export function toText(html: string, pageUrl: string, maxChars = 20_000): { title: string | null; text: string } {
  const out: string[] = [];
  const jsonLd: string[] = [];
  const emails = new Set<string>();
  const phones = new Set<string>();
  const links = new Map<string, string>();
  let title = "";
  let skip = 0;
  let nav = 0;
  let inTitle = false;
  let ld = false;
  let ldText = "";
  let anchor: { href: string; text: string } | null = null;
  let base: URL | null = null;
  try { base = new URL(pageUrl); } catch { base = null; }
  const host = base?.hostname.toLowerCase().replace(/^www\./, "") ?? "";

  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "script" && /ld\+json/i.test(attrs.type ?? "")) { ld = true; ldText = ""; return; }
      if (SKIP.has(name)) { skip += 1; return; }
      if (name === "nav") nav += 1;
      if (name === "title") inTitle = true;
      if (skip > 0) return;
      if (/^h[1-6]$/.test(name)) out.push(`\n\n${"#".repeat(Number(name[1]))} `);
      else if (BLOCK.has(name)) out.push("\n");
      if (name === "a" && typeof attrs.href === "string") {
        const href = attrs.href.trim();
        if (/^mailto:/i.test(href)) {
          const address = decodeURIComponent(href.slice(7).split("?")[0] ?? "").trim().toLowerCase();
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) emails.add(address);
        } else if (/^tel:/i.test(href)) {
          const number = decodeURIComponent(href.slice(4)).replace(/[^\d+ ()-]/g, "").trim();
          if (number.replace(/\D/g, "").length >= 7) phones.add(number);
        } else if (base && !/^(javascript|data|#)/i.test(href)) {
          try {
            const to = new URL(href, base);
            to.hash = "";
            if ((to.protocol === "http:" || to.protocol === "https:") && to.hostname.toLowerCase().replace(/^www\./, "") === host) anchor = { href: to.toString(), text: "" };
            // Booking, messaging and social links leave the site: where they go is the fact that matters.
            else if (to.protocol === "http:" || to.protocol === "https:" || to.protocol === "whatsapp:") anchor = { href: to.toString(), text: "" };
          } catch { /* not an address */ }
        }
      }
    },
    ontext(text) {
      if (ld) { ldText += text; return; }
      if (inTitle) { title += text; return; }
      if (skip > 0) return;
      if (anchor) anchor.text += text;
      // The menu's words are noise in the text. Its links are kept, below.
      if (nav === 0) out.push(text);
    },
    onclosetag(name) {
      if (name === "script" && ld) {
        ld = false;
        try { jsonLd.push(JSON.stringify(JSON.parse(ldText))); } catch { /* not JSON: dropped */ }
        return;
      }
      if (SKIP.has(name)) { skip = Math.max(0, skip - 1); return; }
      if (name === "nav") nav = Math.max(0, nav - 1);
      if (name === "title") inTitle = false;
      if (name === "a" && anchor) {
        const label = anchor.text.replace(/\s+/g, " ").trim().slice(0, 80);
        if (!links.has(anchor.href) || (!links.get(anchor.href) && label)) links.set(anchor.href, label);
        anchor = null;
      }
      if (skip === 0 && BLOCK.has(name) && name !== "br") out.push("\n");
    },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.write(html);
  parser.end();

  const body = out.join("").replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const own = [...links].filter(([href]) => { try { return new URL(href).hostname.toLowerCase().replace(/^www\./, "") === host; } catch { return false; } });
  const away = [...links].filter(([href]) => !own.some(([o]) => o === href));
  const head = [
    emails.size ? `Email addresses the page links to: ${[...emails].slice(0, 10).join(", ")}` : null,
    phones.size ? `Phone numbers the page links to: ${[...phones].slice(0, 10).join(", ")}` : null,
    jsonLd.length ? `Structured data on the page (JSON-LD): ${jsonLd.join(" ").slice(0, 1500)}` : null,
    // Booking, messaging and social links: short, and where they go is itself a fact about how the business takes enquiries.
    away.length ? `Links to other sites:\n${list(away, 15)}` : null,
  ].filter(Boolean).join("\n");
  function list(rows: [string, string][], cap: number): string { return rows.slice(0, cap).map(([href, label]) => `- ${label || "(no text)"}: ${href}`).join("\n"); }
  const tail = own.length ? `Links to other pages of this site:\n${list(own, 80)}` : "";
  // The page's own words come first and are cut first; the link lists at the end are always kept whole, for finding its other pages.
  const room = Math.max(1000, maxChars - head.length - tail.length - 8);
  return { title: title.replace(/\s+/g, " ").trim().slice(0, 200) || null, text: [head, body.slice(0, room), tail].filter(Boolean).join("\n\n") };
}

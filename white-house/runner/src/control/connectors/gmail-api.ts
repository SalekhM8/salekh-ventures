import { randomUUID } from "node:crypto";
import { ControlError } from "../errors.js";
import { isConnectionFailure, MailboxLoginError, MailboxUnreachableError, networkCodeOf, type InboundMail, type Mailbox, type MailCheck, type OutgoingMail, type ReplyQuery } from "./mailbox.js";

/**
 * The test mailbox over the Gmail API: HTTPS only, for a host that lets no SMTP or IMAP out.
 *
 * The same three things as the SMTP and IMAP connector, and no others:
 *   send          one plain text message (users.messages.send)
 *   sentContains  is a message with this Message-ID in Sent (a search for exactly that id)
 *   findReplies   messages that answer one enquiry this system sent
 *
 * READING IS NARROW ON PURPOSE, exactly as with IMAP. The mailbox is never listed. Three searches are made, and
 * only the messages they return are fetched:
 *   - the conversation our own message is in, found by a search for its Message-ID. A message in it is kept only
 *     if its In-Reply-To or References header really names our Message-ID;
 *   - messages from the address written to, since the enquiry was sent;
 *   - messages from the business's own domain, since the enquiry was sent, when the address is on that domain.
 * Nothing is replied to, moved, labelled or deleted.
 *
 * Scopes: gmail.send and gmail.readonly. Nothing wider is asked for (see gmail-authorise.ts) or needed.
 * The access token is held in memory only. No token, and no part of a message, is ever in an error or a log.
 */

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"] as const;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTO_HEADERS = ["auto-submitted", "x-autoreply", "x-autorespond", "x-auto-response-suppress", "precedence"];

export interface GmailApiOptions {
  address: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const b64url = (text: string | Buffer): string => Buffer.from(text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (data: string): string => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** One plain text message as the bytes of an email. The subject and body are encoded, so no header can be forged by what they contain. */
export function toRfc822(from: string, mail: OutgoingMail, messageId: string, date: Date): string {
  const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  const subject = /^[\x20-\x7e]*$/.test(mail.subject) ? clean(mail.subject) : `=?UTF-8?B?${Buffer.from(clean(mail.subject), "utf8").toString("base64")}?=`;
  const body = Buffer.from(mail.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${clean(from)}`, `To: ${clean(mail.to)}`, `Subject: ${subject}`, `Message-ID: ${messageId}`, `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body,
  ].join("\r\n");
}

export function createGmailApiMailbox(options: GmailApiOptions): Mailbox {
  const doFetch = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  const domain = options.address.split("@")[1] ?? "localhost";
  let token: { value: string; until: number } | null = null;

  /** A call that never reached Google failed at the connection: nothing was handed over. */
  async function reach(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (isConnectionFailure(err)) throw new MailboxUnreachableError(networkCodeOf(err) as string);
      throw Object.assign(new ControlError("mailbox_failed", "the Gmail API call did not complete"), { networkCode: networkCodeOf(err) ?? ((err as { name?: string } | null)?.name === "TimeoutError" ? "ETIMEDOUT" : null) });
    }
  }

  async function accessToken(): Promise<string> {
    if (token && token.until > clock() + 60_000) return token.value;
    const res = await reach(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: options.clientId, client_secret: options.clientSecret, refresh_token: options.refreshToken }).toString(),
    });
    // invalid_grant: the refresh token has been revoked or has expired. The same as a refused login: nothing was sent or read.
    if (res.status === 400 || res.status === 401) throw new MailboxLoginError();
    if (!res.ok) throw Object.assign(new ControlError("mailbox_failed", "Google did not issue an access token"), { networkCode: `HTTP_${res.status}` });
    const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof json?.access_token !== "string") throw new ControlError("mailbox_failed", "Google did not issue an access token");
    token = { value: json.access_token, until: clock() + (typeof json.expires_in === "number" ? json.expires_in : 3000) * 1000 };
    return token.value;
  }

  async function api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await reach(`${API}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401 || res.status === 403) { token = null; throw new MailboxLoginError(); }
    // The API's own words are not passed on: they can quote a mailbox's contents.
    if (!res.ok) throw Object.assign(new ControlError("mailbox_failed", "the Gmail API refused the call"), { networkCode: `HTTP_${res.status}` });
    return res.json().catch(() => ({}));
  }

  const search = async (q: string, max = 20): Promise<{ id: string; threadId: string }[]> =>
    (((await api(`/messages?${new URLSearchParams({ q, maxResults: String(max) })}`))?.messages as { id: string; threadId: string }[] | undefined) ?? []);
  const header = (message: any, name: string): string =>
    String((message?.payload?.headers as { name: string; value: string }[] | undefined)?.find((h) => h.name.toLowerCase() === name)?.value ?? "");
  /** The plain text of a message: its text/plain part if it has one. Never an attachment. */
  const textOf = (part: any): string => {
    if (!part) return "";
    if (part.mimeType === "text/plain" && typeof part.body?.data === "string") return fromB64url(part.body.data);
    for (const child of (part.parts as any[] | undefined) ?? []) {
      const found = textOf(child);
      if (found) return found;
    }
    return "";
  };
  const toInbound = (message: any, matchedBy: "header" | "sender"): InboundMail => {
    const headers: Record<string, string> = {};
    for (const name of AUTO_HEADERS) if (header(message, name)) headers[name] = header(message, name);
    const from = (/<([^>]+)>/.exec(header(message, "from"))?.[1] ?? header(message, "from")).trim().toLowerCase();
    return {
      messageId: header(message, "message-id") || `gmail-${message.id}`, from,
      receivedAt: new Date(Number(message.internalDate ?? clock())),
      subject: header(message, "subject").slice(0, 300),
      text: (textOf(message.payload) || String(message.snippet ?? "")).slice(0, 8000),
      headers, matchedBy,
    };
  };

  return {
    address: options.address,
    transport: "gmail_api",

    async send(mail) {
      const wanted = `<${randomUUID()}@${domain}>`;
      // Getting a token and reaching the API come first. If either fails, nothing has been handed over.
      await accessToken();
      let sent: any;
      try {
        sent = await api("/messages/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: b64url(toRfc822(options.address, mail, wanted, new Date(clock()))) }) });
      } catch (err) {
        if (err instanceof MailboxUnreachableError || err instanceof MailboxLoginError) throw err;
        // Google was reached and spoken to. Whether it took the message cannot be known from here: it may have gone.
        throw Object.assign(new ControlError("mail_send_failed", "the Gmail API did not accept the message"), { networkCode: (err as { networkCode?: string | null }).networkCode ?? null });
      }
      // The Message-ID Gmail actually gave the message is read back, in case it replaced ours: replies are recognised by it.
      const stored = typeof sent?.id === "string" ? await api(`/messages/${encodeURIComponent(sent.id)}?format=metadata&metadataHeaders=Message-ID`).catch(() => null) : null;
      return { messageId: header(stored, "message-id") || wanted };
    },

    async sentContains(messageId) {
      return (await search(`rfc822msgid:${messageId} in:sent`, 1)).length > 0;
    },

    async findReplies(query: ReplyQuery) {
      const found = new Map<string, InboundMail>();
      const own = options.address.toLowerCase();
      // The conversation our own message is in, and nothing else of the mailbox.
      const mine = (await search(`rfc822msgid:${query.messageId}`, 1))[0];
      if (mine) {
        const thread = await api(`/threads/${encodeURIComponent(mine.threadId)}?format=full`);
        for (const message of (thread?.messages as any[] | undefined) ?? []) {
          const names = `${header(message, "in-reply-to")} ${header(message, "references")}`;
          const mail = toInbound(message, "header");
          // Kept only if it truly names our message, was not sent by us, and came after the enquiry.
          if (!names.includes(query.messageId) || mail.from === own || mail.receivedAt.getTime() < query.since.getTime()) continue;
          found.set(message.id as string, mail);
        }
      }
      const after = Math.floor(query.since.getTime() / 1000);
      const senders = [`from:${query.address}`, ...(query.ownDomain ? [`from:${query.ownDomain}`] : [])];
      for (const sender of senders) {
        for (const hit of await search(`${sender} after:${after}`, 20)) {
          if (found.has(hit.id)) continue;
          const mail = toInbound(await api(`/messages/${encodeURIComponent(hit.id)}?format=full`), "sender");
          // The search is by Google's own matching, which is loose. The address is checked again here.
          const fromDomain = mail.from.split("@")[1] ?? "";
          if (mail.from !== query.address.toLowerCase() && !(query.ownDomain && (fromDomain === query.ownDomain || fromDomain.endsWith(`.${query.ownDomain}`)))) continue;
          if (mail.receivedAt.getTime() < query.since.getTime()) continue;
          found.set(hit.id, mail);
        }
      }
      return [...found.values()];
    },

    async check(): Promise<MailCheck> {
      const one = (work: () => Promise<unknown>) => work().then(() => ({ reachable: true }), (err: unknown) => ({
        reachable: false,
        code: err instanceof MailboxLoginError ? "EAUTH" : err instanceof MailboxUnreachableError ? err.networkCode : ((err as { networkCode?: string | null }).networkCode ?? "EFAILED"),
      }));
      // Out: a token can be had and the API answers. In: the mailbox's own profile can be read. Nothing is sent and no message is read.
      const out = await one(() => accessToken());
      const inward = out.reachable ? await one(() => api("/profile")) : out;
      return { out, in: inward };
    },
  };
}

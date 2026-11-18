import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { ControlError } from "../errors.js";
import { createGmailApiMailbox } from "./gmail-api.js";

/**
 * The test mailbox: one Gmail account Salekh owns, used for test enquiries
 * and nothing else. Only the gateway side reads its credentials
 * (TEST_MAILBOX_ADDRESS and TEST_MAILBOX_APP_PASSWORD); no agent and no
 * model is ever given them.
 *
 * Three things can be done with it, and no others:
 *   send          one plain text message, by SMTP over implicit TLS
 *   sentContains  is a message with this Message-ID in the Sent folder (the read back check)
 *   findReplies   messages that answer one enquiry this system sent
 *
 * READING IS NARROW ON PURPOSE. `findReplies` asks the mail server to search
 * for messages whose In-Reply-To or References header names the enquiry's
 * Message-ID, or that come from the address or the business's own domain
 * since the enquiry was sent. Only the messages the server returns for those
 * searches are ever fetched. No other mail in the mailbox is listed, opened,
 * stored or logged. Nothing is ever replied to, moved, flagged or deleted.
 */

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface InboundMail {
  /** The reply's own Message-ID. */
  messageId: string;
  from: string;
  receivedAt: Date;
  subject: string;
  text: string;
  /** Lower case header names: only the few that say whether a machine sent it. */
  headers: Record<string, string>;
  matchedBy: "header" | "sender";
}

export interface ReplyQuery {
  /** The Message-ID of the enquiry. */
  messageId: string;
  /** The address the enquiry went to. */
  address: string;
  /** The business's own domain, when the address is on it. null for an address at a shared mail provider. */
  ownDomain: string | null;
  since: Date;
}

export interface MailCheck {
  /** Can a message be handed to the mail server from here? `code`: the network or login error code when it cannot. */
  out: { reachable: boolean; code?: string };
  /** Can the mailbox be read from here? */
  in: { reachable: boolean; code?: string };
}

export interface Mailbox {
  readonly address: string;
  /** Which way it talks to the mail server: "smtp_imap" or "gmail_api". For the log. */
  readonly transport?: string;
  /**
   * Send one message. Three ways it can fail, and they are not alike:
   *   MailboxUnreachableError  the mail server was never reached. The message CERTAINLY did not go.
   *   MailboxLoginError        the login was refused. The message certainly did not go.
   *   anything else            it MAY have gone. The error carries `networkCode` when there is one.
   */
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Open a connection each way, send nothing, read nothing. For the check at start. */
  check?(): Promise<MailCheck>;
  sentContains(messageId: string): Promise<boolean>;
  findReplies(query: ReplyQuery): Promise<InboundMail[]>;
}

const AUTO_HEADERS = ["auto-submitted", "x-autoreply", "x-autorespond", "x-auto-response-suppress", "precedence"];

/** The mail server refused the login. Nothing was sent or read. Sending stops until someone has looked at the mailbox's password. */
export class MailboxLoginError extends ControlError {
  constructor() {
    super("mailbox_login_failed", "the test mailbox refused the login");
    this.name = "MailboxLoginError";
  }
}

/**
 * The mail server could not be reached at all: the connection was refused, timed out, or the name did not resolve.
 * Nothing was handed over, so nothing was sent. `code` is the network error code and nothing else.
 */
export class MailboxUnreachableError extends ControlError {
  readonly networkCode: string;
  constructor(code: string) {
    super("mail_unreachable", `the mail server could not be reached (${code})`);
    this.name = "MailboxUnreachableError";
    this.networkCode = code;
  }
}

const CONNECTION_CODES = new Set(["ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EDNS", "ECONNECTION", "ESOCKET", "ETLS", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"]);

/** An error's own network code, when it has one that is only a code: upper case letters, digits and underscores. Never its words. */
export function networkCodeOf(err: unknown): string | null {
  const seen = new Set<unknown>();
  for (let e: any = err; e && typeof e === "object" && !seen.has(e); e = e.cause) {
    seen.add(e);
    for (const value of [e.code, e.errno]) if (typeof value === "string" && /^[A-Z][A-Z0-9_]{2,30}$/.test(value)) return value;
  }
  return null;
}

/** Did the connection itself fail? Then nothing can have been sent. */
export function isConnectionFailure(err: unknown): boolean {
  const code = networkCodeOf(err);
  return code !== null && CONNECTION_CODES.has(code);
}

/** A refused login, as nodemailer and imapflow report one. Judged from their error codes, never from the server's words. */
function isLoginFailure(err: unknown): boolean {
  const e = err as { code?: unknown; responseCode?: unknown; authenticationFailed?: unknown; serverResponseCode?: unknown } | null;
  return e?.code === "EAUTH" || e?.responseCode === 535 || e?.responseCode === 534 || e?.authenticationFailed === true || e?.serverResponseCode === "AUTHENTICATIONFAILED";
}

export function createGmailMailbox(options: { address: string; appPassword: string }): Mailbox {
  if (!options.address || !options.appPassword) throw new Error("test mailbox: address and app password are both needed");
  const auth = { user: options.address, pass: options.appPassword };
  const domain = options.address.split("@")[1] ?? "localhost";

  async function withImap<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth, logger: false });
    try {
      await client.connect();
      return await work(client);
    } catch (err) {
      if (err instanceof ControlError) throw err;
      if (isLoginFailure(err)) throw new MailboxLoginError();
      // Never the server's own words: they can quote a mailbox's contents.
      throw new ControlError("mailbox_failed", "the test mailbox could not be read");
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  return {
    address: options.address,

    transport: "smtp_imap",

    async send(mail) {
      const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth, connectionTimeout: 20_000, greetingTimeout: 20_000 });
      // The Message-ID is made here, so the read back check and the reply matcher know it for certain.
      const messageId = `<${randomUUID()}@${domain}>`;
      try {
        // First the connection and the login alone, with nothing handed over. If this fails, the message certainly did not go.
        try {
          await transport.verify();
        } catch (err) {
          if (isLoginFailure(err)) throw new MailboxLoginError();
          throw new MailboxUnreachableError(networkCodeOf(err) ?? "ECONNECTION");
        }
        try {
          await transport.sendMail({ from: options.address, to: mail.to, subject: mail.subject, text: mail.text, messageId });
        } catch (err) {
          if (isLoginFailure(err)) throw new MailboxLoginError();
          // The server was reached and spoken to. Whether it took the message cannot be known from here: it may have gone.
          throw Object.assign(new ControlError("mail_send_failed", "the mail server did not accept the message"), { networkCode: networkCodeOf(err) ?? (typeof (err as any)?.responseCode === "number" ? `SMTP_${(err as any).responseCode}` : null) });
        }
      } finally {
        transport.close();
      }
      return { messageId };
    },

    async check() {
      const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth, connectionTimeout: 15_000, greetingTimeout: 15_000 });
      const out = await transport.verify().then(() => ({ reachable: true }), (err: unknown) => ({ reachable: false, code: isLoginFailure(err) ? "EAUTH" : (networkCodeOf(err) ?? "ECONNECTION") }));
      transport.close();
      const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth, logger: false });
      const inward = await client.connect().then(() => ({ reachable: true }), (err: unknown) => ({ reachable: false, code: isLoginFailure(err) ? "EAUTH" : (networkCodeOf(err) ?? "ECONNECTION") }));
      await client.logout().catch(() => undefined);
      return { out, in: inward };
    },

    sentContains(messageId) {
      return withImap(async (client) => {
        const folders = await client.list();
        const sent = folders.find((f) => f.specialUse === "\\Sent")?.path ?? "[Gmail]/Sent Mail";
        const lock = await client.getMailboxLock(sent);
        try {
          const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
          return Array.isArray(found) && found.length > 0;
        } finally {
          lock.release();
        }
      });
    },

    findReplies(query) {
      return withImap(async (client) => {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const uids = new Map<number, "header" | "sender">();
          const add = (found: number[] | false | undefined, by: "header" | "sender") => {
            for (const uid of Array.isArray(found) ? found : []) if (!uids.has(uid)) uids.set(uid, by);
          };
          // The server does the searching. Mail that does not match is never sent to this process at all.
          add(await client.search({ header: { "in-reply-to": query.messageId } }, { uid: true }), "header");
          add(await client.search({ header: { references: query.messageId } }, { uid: true }), "header");
          add(await client.search({ from: query.address, since: query.since }, { uid: true }), "sender");
          if (query.ownDomain) add(await client.search({ from: `@${query.ownDomain}`, since: query.since }, { uid: true }), "sender");
          const mails: InboundMail[] = [];
          for (const [uid, matchedBy] of uids) {
            const message = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
            if (!message || !message.source) continue;
            const parsed = await simpleParser(message.source);
            const from = parsed.from?.value[0]?.address?.toLowerCase() ?? "";
            const headers: Record<string, string> = {};
            for (const name of AUTO_HEADERS) {
              const value = parsed.headers.get(name);
              if (value !== undefined) headers[name] = String(value);
            }
            mails.push({
              messageId: parsed.messageId ?? `uid-${uid}`,
              from,
              receivedAt: new Date(message.internalDate ?? parsed.date ?? Date.now()),
              subject: (parsed.subject ?? "").slice(0, 300),
              text: (parsed.text ?? "").slice(0, 8000),
              headers,
              matchedBy,
            });
          }
          return mails;
        } finally {
          lock.release();
        }
      });
    },
  };
}

/** No address or no password: no mailbox. Test enquiries are then not drafted, sent or read. */
/**
 * The test mailbox, from the environment. MAIL_TRANSPORT says which way it talks to the mail server:
 *   (unset) or smtp_imap   SMTP on 465 and IMAP on 993, with TEST_MAILBOX_APP_PASSWORD. Needs those ports open.
 *   gmail_api              the Gmail API over HTTPS, with GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and
 *                          GMAIL_OAUTH_REFRESH_TOKEN. For a host that lets nothing out but HTTPS.
 * null: not configured, so no test enquiry is drafted, sent or read.
 */
export function mailboxFromEnv(env: Record<string, string | undefined>): Mailbox | null {
  const address = env.TEST_MAILBOX_ADDRESS;
  if (!address) return null;
  const transport = env.MAIL_TRANSPORT ?? "smtp_imap";
  if (transport === "gmail_api") {
    const [clientId, clientSecret, refreshToken] = [env.GMAIL_OAUTH_CLIENT_ID, env.GMAIL_OAUTH_CLIENT_SECRET, env.GMAIL_OAUTH_REFRESH_TOKEN];
    return clientId && clientSecret && refreshToken ? createGmailApiMailbox({ address, clientId, clientSecret, refreshToken }) : null;
  }
  if (transport !== "smtp_imap") throw new Error("MAIL_TRANSPORT must be smtp_imap or gmail_api");
  return env.TEST_MAILBOX_APP_PASSWORD ? createGmailMailbox({ address, appPassword: env.TEST_MAILBOX_APP_PASSWORD }) : null;
}

/**
 * The OWNER's mailbox (for example hello@salekhventures.com), for follow-up emails after a call. Never the test
 * mailbox: a follow-up is from Salekh, by name, to someone he has spoken to. Over the Gmail API only:
 *   OWNER_MAIL_ADDRESS                  the address it sends from
 *   OWNER_GMAIL_OAUTH_REFRESH_TOKEN     its own refresh token (npm run gmail-authorise -- --owner)
 *   OWNER_GMAIL_OAUTH_CLIENT_ID, _SECRET  optional: the OAuth client, when not the same as GMAIL_OAUTH_CLIENT_ID / _SECRET
 * null: not configured (or the same address as the test mailbox, which is refused). Follow-ups are then drafted and
 * approved but never sent: the card offers a copy to send by hand.
 */
export function ownerMailboxFromEnv(env: Record<string, string | undefined>): { mailbox: Mailbox | null; why: string | null } {
  const address = env.OWNER_MAIL_ADDRESS?.trim();
  if (!address) return { mailbox: null, why: "OWNER_MAIL_ADDRESS is not set" };
  if (env.TEST_MAILBOX_ADDRESS && env.TEST_MAILBOX_ADDRESS.trim().toLowerCase() === address.toLowerCase()) {
    return { mailbox: null, why: "OWNER_MAIL_ADDRESS is the test mailbox: follow-ups are never sent from the test mailbox" };
  }
  const clientId = env.OWNER_GMAIL_OAUTH_CLIENT_ID || env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.OWNER_GMAIL_OAUTH_CLIENT_SECRET || env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = env.OWNER_GMAIL_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return { mailbox: null, why: "the owner mailbox's OAuth client or OWNER_GMAIL_OAUTH_REFRESH_TOKEN is not set" };
  return { mailbox: createGmailApiMailbox({ address, clientId, clientSecret, refreshToken }), why: null };
}

import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { ControlError } from "../errors.js";

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

export interface Mailbox {
  readonly address: string;
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
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

    async send(mail) {
      const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth });
      // The Message-ID is made here, so the read back check and the reply matcher know it for certain.
      const messageId = `<${randomUUID()}@${domain}>`;
      try {
        await transport.sendMail({ from: options.address, to: mail.to, subject: mail.subject, text: mail.text, messageId });
      } catch (err) {
        // A refused login means the message certainly did not go. Anything else, and it may have.
        if (isLoginFailure(err)) throw new MailboxLoginError();
        throw new ControlError("mail_send_failed", "the mail server did not accept the message");
      } finally {
        transport.close();
      }
      return { messageId };
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
export function mailboxFromEnv(address: string | undefined, appPassword: string | undefined): Mailbox | null {
  return address && appPassword ? createGmailMailbox({ address, appPassword }) : null;
}

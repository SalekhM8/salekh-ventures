import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Runtime } from "./runtime.js";


export interface ServerOptions {
  /** With no runtime the server answers the health check and nothing else. */
  runtime?: Runtime;
  /** WH_API_TOKEN. The API routes do not start without it. */
  token?: string;
  /**
   * true when the server sits behind a proxy that sets X-Forwarded-For (Railway does): the caller's address is
   * then the first one in that header. false: the address of the connection itself.
   */
  trustProxy?: boolean;
  now?: () => number;
}

/** After this many wrong or missing tokens from one address inside the window, that address is told to wait. */
const MAX_FAILED_AUTH = 10;
const FAILED_AUTH_WINDOW_MS = 5 * 60_000;
const MAX_TRACKED_ADDRESSES = 5000;

const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

/** Constant time: both sides are hashed to the same length first, so neither the token nor its length shows in the timing. */
function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}

/**
 * The runner's HTTP server: the health check, and the API in runner/API.md
 * when it is given a runtime and a token. The browser never calls this: the
 * site's server does, with the token.
 */
export function createRunnerServer(options: ServerOptions = {}): Server {
  const { runtime } = options;
  const token = options.token ?? "";
  if (runtime && !token) {
    throw new Error("WH_API_TOKEN is not set. The API routes are not started without it.");
  }

  async function api(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], rt: Runtime, query: URLSearchParams): Promise<void> {
    const body = method === "POST" ? await readJson(req).catch(() => undefined) : {};
    if (body === undefined) return send(res, 400, { reason: "invalid_json" });
    const [a, b, c] = parts.map((p) => decodeURIComponent(p));
    const route = `${method} ${a}${parts.length > 1 ? "/:id" : ""}${c ? `/${c}` : ""}`;
    const fail = (r: { status: number; reason?: string }) => send(res, r.status, r.status === 404 ? { error: "not_found" } : { reason: r.reason });

    switch (parts.length <= 3 ? route : "") {
      case "GET house":
        return send(res, 200, await rt.house());
      case "GET outputs/:id": {
        const r = await rt.getOutput(b as string);
        return r.status === 200 ? send(res, 200, r.output) : fail(r);
      }
      case "POST outputs/:id/score": {
        const r = await rt.scoreOutput(b as string, body);
        return r.status === 200 ? send(res, 200, { ok: true }) : fail(r);
      }
      case "GET rooms/:id/enquiries": {
        const r = await rt.listSent(b as string, query.get("since"));
        return r.status === 200 ? send(res, 200, { enquiries: r.enquiries }) : fail(r);
      }
      case "GET rooms/:id/replies": {
        const r = await rt.listReplies(b as string, query.get("since"));
        return r.status === 200 ? send(res, 200, { replies: r.replies }) : fail(r);
      }
      case "GET rooms/:id/approvals": {
        const r = await rt.listApprovals(b as string);
        return r.status === 200 ? send(res, 200, { approvals: r.approvals }) : fail(r);
      }
      case "GET rooms/:id/calls": {
        const r = await rt.listCalls(b as string);
        return r.status === 200 ? send(res, 200, { calls: r.calls }) : fail(r);
      }
      case "POST prospects/:id/outcome": {
        const r = await rt.recordCallOutcome(b as string, body);
        return r.status === 200 ? send(res, 200, { ok: true }) : fail(r);
      }
      case "GET rooms/:id/followups": {
        const r = await rt.listFollowups(b as string);
        return r.status === 200 ? send(res, 200, { followups: r.followups, rung: r.rung, ownerMailbox: r.ownerMailbox, drafting: r.drafting }) : fail(r);
      }
      case "POST rooms/:id/followup-rung": {
        const r = await rt.setFollowupRung(b as string, body);
        return r.status === 200 ? send(res, 200, { rung: r.rung }) : fail(r);
      }
      case "POST prospects/:id/followup": {
        const r = await rt.requestFollowup(b as string, body);
        return r.status === 200 ? send(res, 202, { ok: true }) : fail(r);
      }
      case "POST followups/:id": {
        const r = await rt.editFollowup(b as string, body);
        return r.status === 200 ? send(res, 200, { followup: r.followup }) : fail(r);
      }
      case "POST followups/:id/decision": {
        const r = await rt.decideFollowup(b as string, body);
        return r.status === 200 ? send(res, 200, r.result) : fail(r);
      }
      case "POST approvals/:id": {
        // "batch" is not an id: several decisions in one request, each through the single path.
        if (b === "batch") {
          const r = await rt.decideBatch(body);
          return r.status === 200 ? send(res, 200, { results: r.results }) : fail(r);
        }
        const r = await rt.answerApproval(b as string, body);
        return r.status === 200 ? send(res, 200, r.result) : fail(r);
      }
      case "POST kill-switch": {
        const r = await rt.setKillSwitch(body);
        return r.status === 200 ? send(res, 200, { killSwitch: r.killSwitch }) : fail(r);
      }
      case "POST rooms/:id/run": {
        const r = await rt.startRun(b as string, body);
        return r.status === 202 ? send(res, 202, { runId: r.runId }) : fail(r);
      }
      case "POST rooms/:id/acknowledge": {
        const r = await rt.acknowledge(b as string);
        return r.status === 200 ? send(res, 200, { ok: true }) : fail(r);
      }
      case "POST ask": {
        const r = await rt.ask(body);
        return r.status === 202 ? send(res, 202, { id: r.id }) : fail(r);
      }
      case "GET instructions": {
        const r = await rt.listInstructions();
        return r.status === 200 ? send(res, 200, { instructions: r.instructions }) : fail(r);
      }
      case "POST instructions/:id": {
        const r = await rt.decideInstruction(b as string, body);
        return r.status === 200 ? send(res, 200, { instruction: r.instruction }) : fail(r);
      }
      default:
        return send(res, 404, { error: "not_found" });
    }
  }

  const clock = options.now ?? Date.now;
  const failures = new Map<string, { count: number; since: number }>();
  const addressOf = (req: IncomingMessage): string => {
    const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
    return (forwarded || req.socket.remoteAddress || "unknown").slice(0, 64);
  };
  /** Count one wrong token. Returns true once this address has had too many. */
  const tooMany = (address: string, failed: boolean): boolean => {
    const now = clock();
    let entry = failures.get(address);
    if (entry && now - entry.since > FAILED_AUTH_WINDOW_MS) { failures.delete(address); entry = undefined; }
    if (!failed) return (entry?.count ?? 0) >= MAX_FAILED_AUTH;
    if (!entry) {
      // Bounded: a flood of addresses cannot grow this without end. The oldest entry goes first.
      if (failures.size >= MAX_TRACKED_ADDRESSES) failures.delete(failures.keys().next().value as string);
      entry = { count: 0, since: now };
      failures.set(address, entry);
    }
    entry.count += 1;
    return entry.count > MAX_FAILED_AUTH;
  };

  return createServer((req, res) => {
    let pathname: string;
    let query: URLSearchParams;
    try {
      const url = new URL(req.url ?? "/", "http://runner");
      pathname = url.pathname;
      query = url.searchParams;
    } catch {
      return send(res, 404, { error: "not_found" });
    }
    const method = req.method ?? "GET";
    // The one route with no token. It says the process is up and nothing else: no version, no uptime, no state.
    if (method === "GET" && pathname === "/health") return send(res, 200, { status: "ok" });
    const parts = pathname.split("/").filter(Boolean);
    if (!runtime || parts[0] !== "v1") return send(res, 404, { error: "not_found" });
    // Every route under /v1 needs the token. It is checked here, before any route is looked at.
    const address = addressOf(req);
    if (!tokenMatches(req.headers.authorization, token)) {
      if (tooMany(address, true)) {
        res.setHeader("retry-after", String(Math.ceil(FAILED_AUTH_WINDOW_MS / 1000)));
        return send(res, 429, { error: "too_many_attempts" });
      }
      return send(res, 401, { error: "unauthorised" });
    }
    const routeName = `${method} /v1/${parts[1] ?? ""}`.slice(0, 40).replace(/[^A-Za-z0-9/ _-]/g, "");
    api(req, res, method, parts.slice(1), runtime, query).catch((err: unknown) => {
      // Nothing the caller sent is written to the log: not the path beyond its first word, not the body, not an error's own text.
      console.error(`${routeName} failed: ${err instanceof Error ? err.name : "error"}`);
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  });
}

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Runtime } from "./runtime.js";

const startedAt = Date.now();

export interface ServerOptions {
  /** With no runtime the server answers the health check and nothing else. */
  runtime?: Runtime;
  /** WH_API_TOKEN. The API routes do not start without it. */
  token?: string;
}

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

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
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

  async function api(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], rt: Runtime): Promise<void> {
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
      case "POST approvals/:id": {
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
      case "POST ask":
        return send(res, 501, { reason: "not_built" });
      default:
        return send(res, 404, { error: "not_found" });
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://runner");
    const method = req.method ?? "GET";
    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return send(res, 200, {
        status: "ok",
        service: "white-house-runner",
        api: runtime ? "v1" : "off",
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (!runtime || parts[0] !== "v1") return send(res, 404, { error: "not_found" });
    if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { error: "unauthorised" });
    api(req, res, method, parts.slice(1), runtime).catch((err: unknown) => {
      console.error(`${method} ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  });
}

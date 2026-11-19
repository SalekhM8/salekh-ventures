/* Passes the house UI's requests to the White House runner, adding the token
   on the server so it never reaches the browser.

   These routes can approve actions and flip the kill switch. On a local dev
   server they are open. Anywhere else they need the owner's signed session
   cookie (src/lib/houseAuth.ts); without it they answer 401. */

import { cookies } from "next/headers";
import { mayUseLiveHouse, SESSION_COOKIE } from "@/lib/houseAuth";

const ALLOWED = [
  /^v1\/house$/,
  /^v1\/outputs\/[\w-]+$/,
  /^v1\/outputs\/[\w-]+\/score$/,
  /^v1\/approvals\/[\w-]+$/,
  /^v1\/kill-switch$/,
  /^v1\/rooms\/[\w-]+:[\w-]+\/(run|acknowledge|approvals|calls|followups|followup-rung|plans)$/,
  /^v1\/prospects\/[\w-]+\/(outcome|followup|put-back|plan)$/,
  /^v1\/followups\/[\w-]+$/,
  /^v1\/followups\/[\w-]+\/decision$/,
  /^v1\/ask$/,
  /^v1\/instructions$/,
  /^v1\/instructions\/[\w-]+$/,
];

async function forward(request: Request, path: string[]) {
  const url = process.env.WH_RUNNER_URL;
  const token = process.env.WH_API_TOKEN;
  if (!mayUseLiveHouse((await cookies()).get(SESSION_COOKIE)?.value)) return Response.json({ reason: "not_signed_in" }, { status: 401 });
  if (!url || !token) return Response.json({ reason: "runner_not_connected" }, { status: 503 });
  // A change must come from this site's own pages, never from another site's form or script.
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) return Response.json({ reason: "bad_origin" }, { status: 403 });
  }
  const joined = path.map(decodeURIComponent).join("/");
  if (!ALLOWED.some((re) => re.test(joined))) return Response.json({ reason: "not_found" }, { status: 404 });
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/${joined}`, {
      method: request.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ reason: "runner_unreachable" }, { status: 503 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}

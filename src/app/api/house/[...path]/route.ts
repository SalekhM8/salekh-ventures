/* Passes the house UI's requests to the White House runner, adding the token
   on the server so it never reaches the browser.

   DEVELOPMENT ONLY. The private UI has no login yet, and these routes can
   approve actions and flip the kill switch. Until login exists they refuse to
   work anywhere but a local dev server. */

const ALLOWED = [
  /^v1\/house$/,
  /^v1\/outputs\/[\w-]+$/,
  /^v1\/outputs\/[\w-]+\/score$/,
  /^v1\/approvals\/[\w-]+$/,
  /^v1\/kill-switch$/,
  /^v1\/rooms\/[\w-]+:[\w-]+\/(run|acknowledge)$/,
  /^v1\/ask$/,
];

async function forward(request: Request, path: string[]) {
  const url = process.env.WH_RUNNER_URL;
  const token = process.env.WH_API_TOKEN;
  if (process.env.NODE_ENV !== "development" || !url || !token) {
    return Response.json({ reason: "runner_not_connected" }, { status: 503 });
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

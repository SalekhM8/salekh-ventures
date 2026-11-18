import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GMAIL_SCOPES } from "./control/connectors/gmail-api.js";

/**
 * npm run gmail-authorise
 *
 * Run once, on a person's own machine, to let the runner use the test mailbox through the Gmail API. It:
 *   1. listens on this machine only (127.0.0.1, a free port);
 *   2. prints a Google address to open in a browser WHILE SIGNED IN AS THE TEST MAILBOX;
 *   3. receives Google's answer on that listener, checks it is the answer to this request, and exchanges it;
 *   4. writes the refresh token into runner/.env.railway as GMAIL_OAUTH_REFRESH_TOKEN, without printing it.
 *
 * `npm run gmail-authorise -- --owner` does the same for the OWNER's mailbox (follow-up emails after a call) and
 * writes OWNER_GMAIL_OAUTH_REFRESH_TOKEN instead. Sign in as that mailbox, not the test one.
 *
 * It asks for two permissions and no more: sending mail, and reading mail. It needs GMAIL_OAUTH_CLIENT_ID and
 * GMAIL_OAUTH_CLIENT_SECRET (an OAuth client of type "Desktop app"), from the environment or runner/.env.
 * See DEPLOY.md for the Google Cloud side.
 */

/** The consent address. PKCE and a random state: the answer is only accepted if it is the answer to this very request. */
export function consentUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: input.clientId, redirect_uri: input.redirectUri, response_type: "code", scope: GMAIL_SCOPES.join(" "),
    // offline + consent: Google then issues a refresh token, which is what the server needs.
    access_type: "offline", prompt: "consent", state: input.state, code_challenge: input.challenge, code_challenge_method: "S256",
  })}`;
}

/** Put one variable into an env file, replacing its line if it is there. Everything else in the file is left as it is. */
export function writeEnvValue(file: string, name: string, value: string): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const at = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    lines.push(`${name}=${value}`);
  }
  // Readable by this user only.
  writeFileSync(file, `${lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function main(): Promise<void> {
  try {
    if (!process.env.GMAIL_OAUTH_CLIENT_ID) process.loadEnvFile(".env");
  } catch {
    // No .env file: the environment has to provide them.
  }
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET are needed (in the environment or in runner/.env).");
    process.exit(1);
  }
  // --owner: the owner's own mailbox (hello@...), for follow-up emails, written as OWNER_GMAIL_OAUTH_REFRESH_TOKEN.
  const owner = process.argv.includes("--owner");
  const variable = owner ? "OWNER_GMAIL_OAUTH_REFRESH_TOKEN" : "GMAIL_OAUTH_REFRESH_TOKEN";
  const who = owner ? "the OWNER MAILBOX (the address follow-up emails are sent from, OWNER_MAIL_ADDRESS)" : "the TEST MAILBOX";
  const out = path.resolve(process.env.GMAIL_AUTHORISE_OUT ?? ".env.railway");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const answer = (status: number, text: string) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); res.end(text); };
      if (url.searchParams.get("state") !== state) return answer(400, "This is not the answer to the request that is waiting. Nothing was done.");
      const given = url.searchParams.get("code");
      if (!given) {
        answer(400, "Google did not give permission. Nothing was written. You can close this window.");
        server.close();
        return reject(new Error(`permission was not given (${(url.searchParams.get("error") ?? "no code").replace(/[^a-z_]/gi, "").slice(0, 40)})`));
      }
      answer(200, "Done. You can close this window and go back to the terminal.");
      server.close();
      resolve(given);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const redirectUri = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      (server as unknown as { redirectUri: string }).redirectUri = redirectUri;
      redirect = redirectUri;
      console.log(`Open this address in a browser while signed in as ${who}, and allow the two permissions it asks for (send mail, read mail):\n`);
      console.log(consentUrl({ clientId, redirectUri, state, challenge }));
      console.log("\nWaiting for Google to answer on this machine (up to ten minutes)...");
    });
    setTimeout(() => { server.close(); reject(new Error("nobody answered within ten minutes")); }, 10 * 60_000).unref();
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, code_verifier: verifier }).toString(),
  });
  const json = (await res.json().catch(() => null)) as { refresh_token?: unknown; scope?: unknown } | null;
  if (!res.ok || typeof json?.refresh_token !== "string") throw new Error(`Google did not issue a refresh token (HTTP ${res.status}). Nothing was written.`);
  const granted = String(json.scope ?? "").split(" ").filter(Boolean).sort();
  if (granted.length > 0 && JSON.stringify(granted) !== JSON.stringify([...GMAIL_SCOPES].sort())) {
    throw new Error("the permissions given are not exactly the two asked for (send mail, read mail). Nothing was written. Run it again and tick both.");
  }
  writeEnvValue(out, variable, json.refresh_token);
  console.log(`\nThe refresh token was written to ${out} as ${variable}. It has not been printed.`);
  console.log(owner
    ? "Set it on the server with OWNER_MAIL_ADDRESS (and the OAuth client, GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET, or OWNER_GMAIL_OAUTH_CLIENT_ID and _SECRET). See DEPLOY.md."
    : "Set it on the server with GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and MAIL_TRANSPORT=gmail_api (see DEPLOY.md).");
}

let redirect = "";
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then(() => process.exit(0), (err: unknown) => { console.error(err instanceof Error ? err.message : "it did not work"); process.exit(1); });

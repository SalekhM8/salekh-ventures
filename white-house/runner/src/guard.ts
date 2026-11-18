/**
 * The last line of defence. An error that nothing caught (a stream that failed with nobody listening, a promise
 * that was rejected and never handled) would otherwise stop the whole server: the API, the schedule, the sending
 * and the reading of replies, for every floor, over one bad web page.
 *
 * This logs one fixed line (the kind of error and its code: never its words, which can hold anything) and keeps
 * the server up. It is not a licence to carry on regardless: after an uncaught exception a process may be in a
 * bad way, so if several come close together it stops, cleanly, with a non-zero code, and the host restarts it.
 * A run cut off by that restart is closed and started again at boot.
 */
export interface GuardTarget {
  on(event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

export function installProcessGuard(target: GuardTarget, options: { log?: (line: string) => void; exit?: (code: number) => void; now?: () => number; limit?: number; windowMs?: number } = {}): void {
  const log = options.log ?? ((line: string) => console.error(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? Date.now;
  const limit = options.limit ?? 5;
  const windowMs = options.windowMs ?? 60_000;
  const recent: number[] = [];
  const describe = (reason: unknown): string => {
    const e = reason as { name?: unknown; code?: unknown } | null;
    const name = typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
    const code = typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(e.code) ? ` ${e.code}` : "";
    return `${name}${code}`;
  };
  target.on("unhandledRejection", (reason) => {
    log(`unhandled rejection, kept from stopping the server: ${describe(reason)}`);
  });
  target.on("uncaughtException", (reason) => {
    const at = now();
    recent.push(at);
    while (recent.length > 0 && at - (recent[0] as number) > windowMs) recent.shift();
    log(`uncaught exception, kept from stopping the server: ${describe(reason)}`);
    if (recent.length >= limit) {
      log(`${recent.length} uncaught exceptions within ${Math.round(windowMs / 1000)} seconds: stopping, to be started again clean`);
      exit(1);
    }
  });
}

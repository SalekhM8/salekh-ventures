import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_ONLY_ENV, BOOTSTRAP_FAILED, bootstrapFromEnv } from "./bootstrap.js";

/**
 * What the image runs. Two steps, in two processes, so that the server never holds the database owner's way in:
 *
 *   1. this process sets the database up (bootstrap.ts), if DATABASE_URL_ADMIN is given;
 *   2. it then starts the server as a child, with the owner's URL and everything like it taken out of the
 *      child's environment. When this process is root (as in the image), the child is started as the
 *      unprivileged user, so it can read neither this process's environment nor the migration files, which
 *      belong to root.
 *
 * If the setup fails, the server is not started and the exit code is 1.
 */

/** The environment the server is given: everything except the database owner's way in. */
export function serverEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || (ADMIN_ONLY_ENV as readonly string[]).includes(name) || name === "MIGRATIONS_DIR") continue;
    out[name] = value;
  }
  // The setup has been done here, if it was going to be: the server must not look for it again.
  delete out.WH_BOOTSTRAP;
  return out;
}

async function main(): Promise<void> {
  if (process.env.DATABASE_URL_ADMIN) {
    try {
      await bootstrapFromEnv(process.env);
    } catch (err) {
      console.error(err instanceof Error ? err.message : BOOTSTRAP_FAILED);
      process.exit(1);
    }
  } else {
    console.log("DATABASE_URL_ADMIN is not set: the database is taken to be set up already.");
  }
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const uid = Number(process.env.WH_RUN_UID ?? 1000);
  const gid = Number(process.env.WH_RUN_GID ?? 1000);
  const env = serverEnv(process.env);
  // The ordinary user's own home, not root's: anything the server or an agent run keeps in its home must be writable by it.
  if (asRoot) env.HOME = process.env.WH_RUN_HOME ?? "/home/node";
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js")], {
    stdio: "inherit", env, cwd: process.cwd(),
    // Root is for the setup only. The server, and every agent it starts, runs as the ordinary user.
    ...(asRoot ? { uid, gid } : {}),
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    console.error("the server could not be started");
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) void main();

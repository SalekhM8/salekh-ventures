import { createDb } from "../control/db.js";
import { markTicketDone, openTickets } from "./instructions.js";

/**
 * The engineering queue: what Salekh asked the Chief of Staff for that needs a change to the code.
 *
 *   npm run tickets                          list every ticket still waiting, oldest first, with the brief
 *   npm run tickets -- done <id> "<note>"    mark one done. The note is what Salekh reads, in plain words:
 *                                            what changed, and where he will see it. Only after it is deployed.
 *
 * Connects with the gateway's role: DATABASE_URL_GATEWAY and WH_TENANT_ID, from the environment or runner/.env.
 */
try {
  if (!process.env.DATABASE_URL_GATEWAY) process.loadEnvFile(".env");
} catch {
  // No .env file: the environment has to provide them.
}
const url = process.env.DATABASE_URL_GATEWAY;
const tenantId = process.env.WH_TENANT_ID;
const [command, ...args] = process.argv.slice(2);
if (!url || !tenantId) {
  console.error("DATABASE_URL_GATEWAY and WH_TENANT_ID are needed.");
  process.exit(1);
}
const db = createDb(url, 2);
try {
  if (command === undefined || command === "list") {
    const tickets = await openTickets(db, tenantId);
    if (!tickets.length) console.log("No engineering tickets waiting.");
    for (const t of tickets) {
      console.log(`\n${t.id}   ${t.at}   ${t.department ?? ""}`);
      console.log(`  He said:    ${t.said}`);
      if (t.restated) console.log(`  Understood: ${t.restated}`);
      console.log(`  Brief:\n${t.ticket.split("\n").map((l) => `    ${l}`).join("\n")}`);
    }
  } else if (command === "done") {
    const [id, note] = args;
    if (!id || !note) throw new Error('Usage: npm run tickets -- done <id> "<what was done, in plain words>"');
    const r = await markTicketDone(db, tenantId, id, note);
    console.log(r === "done" ? "Marked done. Salekh sees your note on the Chief of Staff panel." : r === "not_found" ? "No such ticket." : "That ticket isn't waiting for engineering.");
    if (r !== "done") process.exitCode = 1;
  } else {
    throw new Error('Use: list, or done <id> "<note>"');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}

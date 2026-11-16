import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { requestErrorOf } from "./agents/model-caller.js";
import { STAGE_SCHEMAS } from "./outreach/stages.js";

/**
 * npm run check-schemas
 *
 * Sends every structured-output schema the pipeline uses to the real API, with a one line prompt and a tiny
 * answer allowed, and prints pass or the API's own error for each. It exists because a schema the API will not
 * compile fails every call at that stage, and no test can see that: tests never call the API.
 *
 * Run it before any deploy and after any change to a schema in src/outreach/stages.ts. It costs a fraction of
 * a penny. It needs ANTHROPIC_API_KEY_SALEKH, from the environment or runner/.env. Exits 1 if any schema fails.
 */
try {
  if (!process.env.ANTHROPIC_API_KEY_SALEKH) process.loadEnvFile(".env");
} catch {
  // No .env file: the environment has to provide it.
}
const apiKey = process.env.ANTHROPIC_API_KEY_SALEKH;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY_SALEKH is needed.");
  process.exit(1);
}
const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
let failed = 0;
for (const [stage, { schema, model }] of Object.entries(STAGE_SCHEMAS)) {
  try {
    // `create`, not `parse`: with so few tokens the answer is cut off, and only the API's acceptance of the format is being checked.
    const response = await client.messages.create({
      model, max_tokens: 16,
      messages: [{ role: "user", content: "This is a check that the answer format is accepted. Give the smallest valid answer." }],
      output_config: { format: zodOutputFormat(schema as z.ZodType), effort: "low" },
    });
    // A cut-off answer is expected with so few tokens. What matters is that the request was accepted.
    console.log(`${stage.padEnd(8)} pass   (${model}, stopped: ${response.stop_reason})`);
  } catch (err) {
    failed += 1;
    const refused = requestErrorOf(err);
    console.log(`${stage.padEnd(8)} FAIL   ${refused ? `${refused.status} ${refused.type}: ${refused.message}` : `could not be checked: ${err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : "error"}`}`);
  }
}
process.exit(failed > 0 ? 1 : 0);

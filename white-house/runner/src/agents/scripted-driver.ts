import type { AgentDriver, DriverResult, RunSpec } from "./driver.js";

/**
 * A driver that plays the part of the model from a script. Used by every
 * test and by offline eval checks. It makes no network call of any kind.
 * The script acts through `spec.call`, so the allow list applies to it
 * exactly as it does to the real model.
 */
export function createScriptedDriver(script: (spec: RunSpec) => Promise<DriverResult>): AgentDriver {
  return { run: (spec) => script(spec) };
}

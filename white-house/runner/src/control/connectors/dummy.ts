import type { CapUsageQuery, Connector, ConnectorCall, ConnectorResult, ReadBackResult } from "./connector.js";

/**
 * The dummy connector: an outside system that is a Map in memory. It exists
 * so execution and read back can be exercised, and made to fail on purpose,
 * with no real system and no credential.
 */
export interface DummyConnector extends Connector {
  /** Every call that reached execute, in order. */
  readonly executions: ConnectorCall[];
  /** The "outside system": what each target is currently set to. */
  readonly state: Map<string, number>;
  /** The next execute throws. */
  failNextExecute(): void;
  /** The next execute reports success but changes nothing, so its read back fails. */
  failNextReadBack(): void;
  /** The next read back throws. */
  throwOnNextReadBack(): void;
  /** What the outside system claims has been used of the cap. null: it has no figure. */
  setLiveCapUsage(units: number | null): void;
}

export function createDummyConnector(): DummyConnector {
  const executions: ConnectorCall[] = [];
  const state = new Map<string, number>();
  let failExecute = false;
  let dropNextWrite = false;
  let throwReadBack = false;
  let liveUsage: number | null = null;
  let counter = 0;

  const slot = (call: ConnectorCall) => {
    const payload = call.payload as { target: string };
    return `${call.tenantId}|${call.businessId}|${payload.target}`;
  };

  return {
    executions,
    state,
    failNextExecute: () => void (failExecute = true),
    failNextReadBack: () => void (dropNextWrite = true),
    throwOnNextReadBack: () => void (throwReadBack = true),
    setLiveCapUsage: (units) => void (liveUsage = units),

    async execute(call: ConnectorCall): Promise<ConnectorResult> {
      executions.push(call);
      if (failExecute) {
        failExecute = false;
        throw new Error("dummy connector: execute failed on purpose");
      }
      const payload = call.payload as { target: string; units: number };
      counter += 1;
      const reference = `dummy-${counter}`;
      if (dropNextWrite) {
        dropNextWrite = false;
        // Says it worked, changed nothing.
        state.set(slot(call), -1);
      } else {
        state.set(slot(call), payload.units);
      }
      return { reference, output: { target: payload.target, units: payload.units } };
    },

    async readBack(call: ConnectorCall): Promise<ReadBackResult> {
      if (throwReadBack) {
        throwReadBack = false;
        throw new Error("dummy connector: read back failed on purpose");
      }
      const payload = call.payload as { units: number };
      const observed = state.get(slot(call));
      return { verified: observed === payload.units, observed: { units: observed ?? null } };
    },

    async liveCapUsage(_query: CapUsageQuery): Promise<number | null> {
      return liveUsage;
    },
  };
}

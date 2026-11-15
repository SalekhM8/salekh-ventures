/**
 * A connector is the only code that talks to an outside system, and the
 * gateway is the only code that holds one. A connector is built with its
 * credential by the gateway process and is never handed to an agent run.
 */

export interface ConnectorCall {
  tenantId: string;
  businessId: string;
  actionType: string;
  /** Unique per action. A connector should pass it on where the outside system accepts one. */
  actionKey: string;
  /** Already checked against the action type's payload shape. */
  payload: unknown;
}

export interface ConnectorResult {
  /** The outside system's own id for what was done. */
  reference: string;
  output: unknown;
}

export interface ReadBackResult {
  /** True only when the outside system shows the change that was asked for. */
  verified: boolean;
  observed?: unknown;
}

export interface CapUsageQuery {
  tenantId: string;
  businessId: string;
  capKey: string;
  window: "day" | "hour";
  now: Date;
}

export interface Connector {
  execute(call: ConnectorCall): Promise<ConnectorResult>;
  /** Read the result back and check the change happened. Leave out where the outside system cannot. */
  readBack?(call: ConnectorCall, result: ConnectorResult): Promise<ReadBackResult>;
  /**
   * The outside system's own figure for what has been used of a cap in the
   * window (for example today's spend read live from an ad account), or null
   * when it has none. The gateway counts whichever is higher, this or its log.
   */
  liveCapUsage?(query: CapUsageQuery): Promise<number | null>;
}

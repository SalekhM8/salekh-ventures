/**
 * The control layer (BRIEF.md section 8): everything between an agent
 * wanting something done and it being done. Nothing here starts an agent,
 * serves HTTP or talks to a real outside system.
 */
export { ControlError } from "./control/errors.js";
export { Db, createDb, isUuid, type Tx } from "./control/db.js";
export { canonicalJson, hashPayload } from "./control/hash.js";
export {
  EVENT_TYPES,
  PAYLOAD_LIFE_MS,
  emitEvent,
  listEvents,
  purgeExpiredPayloads,
  type EventInput,
  type EventRow,
  type EventType,
} from "./control/events.js";
export {
  engageKillSwitch,
  getConfigHistory,
  getCurrentConfig,
  killSwitchState,
  promoteRung,
  resumeKillSwitch,
  setConfig,
  type ConfigKind,
  type ConfigScope,
  type ConfigVersion,
} from "./control/config.js";
export {
  budgetStatus,
  finishRun,
  startRun,
  type BudgetStatus,
  type FinishRunInput,
  type StartRunInput,
  type StartRunResult,
} from "./control/runs.js";
export {
  actionTypes,
  createActionTypeRegistry,
  dummyAction,
  enquiryAction,
  type ActionType,
  type ActionTypeRegistry,
  type CapRule,
  type Rung,
} from "./control/action-types.js";
export type { Connector, ConnectorCall, ConnectorResult, ReadBackResult } from "./control/connectors/connector.js";
export { createDummyConnector, type DummyConnector } from "./control/connectors/dummy.js";
export { DEFAULT_APPROVAL_TTL_MS, decideApproval, type ApprovalAnswer, type DecideResult } from "./control/approvals.js";
export {
  createGateway,
  type ActionRequest,
  type AnswerResult,
  type Gateway,
  type GatewayOptions,
  type MarkWrongResult,
  type RefusalReason,
  type SubmitResult,
} from "./control/gateway.js";

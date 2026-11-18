import { z } from "zod";

/**
 * The closed list of action types (BRIEF.md section 8). An action that is
 * not defined here cannot be carried out by anything. Adding one is a
 * reviewed code change, never config and never an agent's choice.
 */

export type Rung = 1 | 2 | 3 | 4;

export interface CapRule<P> {
  /** Which cap in config (kind "cap") this action counts against. */
  key: string;
  /** "day" is the tenant's calendar day. "hour" is the last 60 minutes. */
  window: "day" | "hour";
  /** How much of the cap one action with this payload uses. */
  units: (payload: P) => number;
}

export interface ActionType<P = any> {
  /** For example "ads.pause_adset". */
  name: string;
  /** The payload shape. Anything else is refused. */
  payload: z.ZodType<P>;
  /** The hard ceiling: the highest rung this action may ever reach, whatever config says. */
  maxRung: Rung;
  /** The cap that applies. Every action type has one. */
  cap: CapRule<P>;
  /** Whether the outside system lets the action be undone. Recorded on every action. */
  undoable: boolean;
  /** The connector that carries it out. */
  connector: string;
  /**
   * True when the payload holds personal data (an address, a message). The gateway then keeps it out of the
   * event stream altogether: events carry its hash, and the payload itself lives only in the approval and
   * the audit row.
   */
  privatePayload?: boolean;
}

export interface ActionTypeRegistry {
  get(name: string): ActionType | undefined;
  names(): string[];
}

export function createActionTypeRegistry(types: readonly ActionType[]): ActionTypeRegistry {
  const byName = new Map<string, ActionType>();
  for (const type of types) {
    if (byName.has(type.name)) throw new Error(`action type ${type.name} is defined twice`);
    if (![1, 2, 3, 4].includes(type.maxRung)) throw new Error(`action type ${type.name} has no valid ceiling`);
    byName.set(type.name, Object.freeze({ ...type }));
  }
  return {
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}

// ---------------------------------------------------------------------------
// The dummy action. Phase 1 has this one action type and no real ones.
// ---------------------------------------------------------------------------

export const dummyPayload = z.strictObject({
  target: z.string().min(1).max(200),
  units: z.number().int().positive().max(1000),
});

export type DummyPayload = z.infer<typeof dummyPayload>;

/** Sets `target` to `units` on the in-memory dummy connector. Touches nothing real. */
export const dummyAction: ActionType<DummyPayload> = {
  name: "dummy.action",
  payload: dummyPayload,
  maxRung: 4,
  cap: { key: "dummy_units_per_day", window: "day", units: (payload) => payload.units },
  undoable: true,
  connector: "dummy",
};

// ---------------------------------------------------------------------------
// The test enquiry by email (mystery shop). The first action type that reaches
// anyone outside the house.
// ---------------------------------------------------------------------------

const uuidText = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const enquiryPayload = z.strictObject({
  /** The row in `enquiries` this is. The connector sends only what that row says. */
  enquiry_id: uuidText,
  prospect_id: uuidText,
  to: z.string().email().max(254),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
});

export type EnquiryPayload = z.infer<typeof enquiryPayload>;

/**
 * Send one short enquiry from the test mailbox to a business's published
 * address. Hard ceiling: rung 3 (act and tell Salekh). It can never be
 * silent. It cannot be undone: an email cannot be unsent.
 */
export const enquiryAction: ActionType<EnquiryPayload> = {
  name: "enquiry.send_email",
  payload: enquiryPayload,
  maxRung: 3,
  // One enquiry is one unit of the day's allowance.
  cap: { key: "enquiries_per_day", window: "day", units: () => 1 },
  undoable: false,
  connector: "mail",
  privatePayload: true,
};

// ---------------------------------------------------------------------------
// The follow-up email after a call. Sent from the OWNER's mailbox, to an address
// Salekh gave, about a call he made. Never to an address the system found.
// ---------------------------------------------------------------------------

export const followupPayload = z.strictObject({
  /** The row in `followups` this is. The connector sends only what that row says. */
  followup_id: uuidText,
  prospect_id: uuidText,
  to: z.string().email().max(254),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});

export type FollowupPayload = z.infer<typeof followupPayload>;

/**
 * Send one follow-up email from the owner's mailbox. Seeded at rung 2 (each needs his yes); the owner may raise it
 * to rung 3 ("don't ask me for this kind") and lower it again. Hard ceiling: rung 3, never silent. Cannot be undone.
 */
export const followupAction: ActionType<FollowupPayload> = {
  name: "followup.send_email",
  payload: followupPayload,
  maxRung: 3,
  cap: { key: "followups_per_day", window: "day", units: () => 1 },
  undoable: false,
  connector: "owner-mail",
  privatePayload: true,
};

/** The list the runner uses. */
export const actionTypes: ActionTypeRegistry = createActionTypeRegistry([dummyAction, enquiryAction, followupAction]);

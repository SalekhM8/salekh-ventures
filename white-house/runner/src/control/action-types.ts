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

/** The list the runner uses. */
export const actionTypes: ActionTypeRegistry = createActionTypeRegistry([dummyAction]);

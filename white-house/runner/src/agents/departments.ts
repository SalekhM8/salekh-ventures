/**
 * The department types that have an agent, as code (BRIEF.md sections 5, 10
 * and 16). A type that is not here has no agent: its room exists in the
 * house but cannot be run.
 *
 * Whether a type is switched on for a given floor is config in the database
 * (kind "schedule", key = department, value {"live": true}), set when the
 * department is registered on that floor.
 */

export type ToolName = "read_targets" | "read_metrics" | "write_output" | "hand_off" | "propose_action";

export interface DepartmentDef {
  type: string;
  /** Pinned by exact id. These ids are complete: they take no date suffix. */
  model: "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";
  /** A session has no timeout of its own, so every run has a turn limit. */
  maxTurns: number;
  /** The in-process tools this department gets. Nothing else exists for it. */
  tools: readonly ToolName[];
  /** Built-in SDK tools this department may use. Empty for all but Research. */
  builtinTools: readonly string[];
  /** What a run is asked to do when nobody supplied a brief. null: a brief is required. */
  defaultBrief: string | null;
}

/** The name the in-process tool server is registered under. Tool names become mcp__wh__<tool>. */
export const TOOL_SERVER = "wh";
export const fullToolName = (tool: string): string => `mcp__${TOOL_SERVER}__${tool}`;

export const DEPARTMENTS: Readonly<Record<string, DepartmentDef>> = {
  // BRIEF.md section 10: Sonnet 5.5 for the daily read. Pulls are plain code.
  data: {
    type: "data",
    model: "claude-sonnet-5-5",
    maxTurns: 15,
    tools: ["read_targets", "read_metrics", "write_output", "hand_off", "propose_action"],
    builtinTools: [],
    defaultBrief:
      "Write today's daily read of the numbers for this floor. Read the targets and the metrics with your tools first. " +
      "Say what the numbers are, what changed over rolling windows, and how they stand against targets. " +
      "If no target is set, say so plainly and do not suggest one. Finish by writing the read with write_output.",
  },
  // A new type (BRIEF.md section 16). The brief has no model row for it: Sonnet 5.5
  // is used, as for the other reading and drafting work. It is the one department
  // with web reading, and it has no tool that acts or hands off.
  research: {
    type: "research",
    model: "claude-sonnet-5-5",
    maxTurns: 40,
    tools: ["read_targets", "write_output"],
    builtinTools: ["WebSearch", "WebFetch"],
    defaultBrief: null,
  },
};

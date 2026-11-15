import { isUuid, type Tx } from "./db.js";
import { ControlError } from "./errors.js";

export interface Member {
  memberId: string;
  role: "owner" | "approver" | "viewer";
  mayApprove: boolean;
  active: boolean;
}

/**
 * Look a member up inside the current tenant. Row level security means a
 * member of another tenant is simply not found.
 */
export async function getMember(tx: Tx, memberId: unknown): Promise<Member | null> {
  if (!isUuid(memberId)) return null;
  const result = await tx.query("select member_id, role, may_approve, status from members where member_id = $1", [
    memberId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return { memberId: row.member_id, role: row.role, mayApprove: row.may_approve, active: row.status === "active" };
}

export function mayApprove(member: Member | null): member is Member {
  return member !== null && member.active && member.mayApprove;
}

export function isOwner(member: Member | null): member is Member {
  return member !== null && member.active && member.role === "owner";
}

/** Settings changes (caps, budgets, targets, rungs, resuming) are for an active owner only. */
export async function requireOwner(tx: Tx, memberId: unknown): Promise<Member> {
  const member = await getMember(tx, memberId);
  if (!isOwner(member)) throw new ControlError("not_permitted", "only an active owner of this tenant may do this");
  return member;
}

/** An active owner, or an active member who may approve. */
export async function requireOwnerOrApprover(tx: Tx, memberId: unknown): Promise<Member> {
  const member = await getMember(tx, memberId);
  if (!isOwner(member) && !mayApprove(member)) {
    throw new ControlError("not_permitted", "only an active owner or approver of this tenant may do this");
  }
  return member as Member;
}

import { z } from "zod";
import { isUuid, type Db } from "./db.js";
import { emitEvent } from "./events.js";
import { hashPayload } from "./hash.js";
import { getMember, mayApprove } from "./members.js";

/**
 * Recording the answer to an approval (BRIEF.md section 8).
 *
 * This only records the answer. It never executes anything: carrying out an
 * approved action is the gateway's job (Gateway.executeApproval), because
 * only the gateway holds a connector. The private UI can therefore record a
 * yes with its own database role, and so can the gateway on behalf of the
 * Telegram backup.
 *
 * Rules enforced here:
 *   - only an active member of this tenant who may approve can answer;
 *     anyone else is ignored and the approval stays as it was;
 *   - a yes names one approval id and carries the hash of the payload the
 *     person saw; a different hash is refused;
 *   - if the stored payload no longer matches its stored hash, the approval
 *     is voided;
 *   - an approval is answered once, and not after it has expired.
 */

/** Approvals expire after 24 hours unless the gateway is built with another life. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const answerShape = z.object({
  tenantId: z.string(),
  approvalId: z.string(),
  memberId: z.string(),
  decision: z.enum(["approve", "reject"]),
  /** Needed for a yes: the hash of the payload the person was shown. */
  payloadHash: z.string().optional(),
  channel: z.enum(["app", "telegram"]),
});

export type ApprovalAnswer = z.infer<typeof answerShape>;

export type DecideResult =
  | { outcome: "approved" | "rejected"; approvalId: string }
  | { outcome: "ignored"; reason: "wrong_account" | "not_found" | "invalid_answer" }
  | { outcome: "refused"; reason: "already_decided" | "expired" | "payload_mismatch" | "payload_changed" };

export async function decideApproval(db: Db, input: ApprovalAnswer, opts: { now?: Date } = {}): Promise<DecideResult> {
  const parsed = answerShape.safeParse(input);
  if (!parsed.success) return { outcome: "ignored", reason: "invalid_answer" };
  const answer = parsed.data;
  if (!isUuid(answer.tenantId) || !isUuid(answer.approvalId)) return { outcome: "ignored", reason: "not_found" };
  const now = opts.now ?? new Date();

  return db.tx(answer.tenantId, async (tx): Promise<DecideResult> => {
    // Row lock: two answers to one approval are handled one after the other.
    const found = await tx.query("select * from approvals where approval_id = $1 for update", [answer.approvalId]);
    const approval = found.rows[0];
    // Another tenant's approval is invisible here, so it is simply not found.
    if (!approval) return { outcome: "ignored", reason: "not_found" };

    const base = {
      tenantId: answer.tenantId,
      businessId: approval.business_id as string,
      department: approval.department as string,
      proposalId: approval.proposal_id as string,
      approvalId: approval.approval_id as string,
      actionType: approval.action_type as string,
      now,
    };

    const member = await getMember(tx, answer.memberId);
    if (!mayApprove(member)) {
      await emitEvent(tx, {
        ...base,
        type: "answer_refused",
        summary: "An answer from an account that may not approve was ignored",
        reasonCode: "wrong_account",
        payload: { memberId: answer.memberId, decision: answer.decision, channel: answer.channel },
      });
      return { outcome: "ignored", reason: "wrong_account" };
    }

    if (approval.status !== "pending") {
      await emitEvent(tx, {
        ...base,
        type: "answer_refused",
        summary: "An answer arrived for an approval that was already closed",
        reasonCode: "already_decided",
        payload: { memberId: member.memberId, status: approval.status },
      });
      return { outcome: "refused", reason: "already_decided" };
    }

    if (now.getTime() >= (approval.expires_at as Date).getTime()) {
      await tx.query("update approvals set status = 'expired' where approval_id = $1", [approval.approval_id]);
      await emitEvent(tx, { ...base, type: "expired", summary: "The approval expired before it was answered", reasonCode: "expired" });
      return { outcome: "refused", reason: "expired" };
    }

    if (hashPayload(approval.payload) !== approval.payload_hash) {
      await tx.query("update approvals set status = 'voided', void_reason = 'payload_changed' where approval_id = $1", [
        approval.approval_id,
      ]);
      await emitEvent(tx, {
        ...base,
        type: "voided",
        summary: "The stored payload no longer matches its hash, so the approval is void",
        reasonCode: "payload_changed",
      });
      return { outcome: "refused", reason: "payload_changed" };
    }

    if (answer.decision === "reject") {
      await tx.query(
        "update approvals set status = 'rejected', decided_by = $2, decided_at = $3, channel = $4 where approval_id = $1",
        [approval.approval_id, member.memberId, now, answer.channel],
      );
      await emitEvent(tx, { ...base, type: "rejected", summary: "The proposal was rejected", payload: { by: member.memberId, channel: answer.channel } });
      return { outcome: "rejected", approvalId: approval.approval_id };
    }

    if (answer.payloadHash !== approval.payload_hash) {
      await emitEvent(tx, {
        ...base,
        type: "answer_refused",
        summary: "A yes was given for a different payload and was refused",
        reasonCode: "payload_mismatch",
        payload: { memberId: member.memberId, given: answer.payloadHash ?? null, stored: approval.payload_hash },
      });
      return { outcome: "refused", reason: "payload_mismatch" };
    }

    await tx.query(
      `update approvals
          set status = 'approved', decided_by = $2, decided_at = $3, channel = $4, approved_payload_hash = $5
        where approval_id = $1`,
      [approval.approval_id, member.memberId, now, answer.channel, answer.payloadHash],
    );
    await emitEvent(tx, { ...base, type: "approved", summary: "The proposal was approved", payload: { by: member.memberId, channel: answer.channel } });
    return { outcome: "approved", approvalId: approval.approval_id };
  });
}

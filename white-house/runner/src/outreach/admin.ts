import { actionTypes } from "../control/action-types.js";
import { canonicalJson } from "../control/hash.js";
import { promoteRung, readCurrent, readRung, setConfig } from "../control/config.js";
import type { Db } from "../control/db.js";
import { ControlError } from "../control/errors.js";
import { companyNumberKey, domainKey } from "./normalise.js";
import { parseOutreachSettings, type OutreachSettings, FIRST_TYPE_ID, toStoredForm, type BusinessType } from "./settings.js";
import { ENQUIRY_ACTION, ENQUIRY_CAP } from "./enquiries.js";
import { addSuppression } from "./store.js";

/**
 * What an owner can do to the Outreach room from the command line until the
 * settings screen exists. Everything here needs the UI's database role: the
 * gateway's role cannot change a setting, and agent tools cannot see them.
 */

async function roomAndOwner(db: Db, tenantId: string, roomId: string): Promise<{ businessId: string; department: string; ownerId: string }> {
  const [business, department] = roomId.split(":");
  return db.tx(tenantId, async (tx) => {
    const floor = (await tx.query("select business_id from businesses where slug = $1 and $2 = any (departments)", [business, department])).rows[0];
    const owner = (await tx.query("select member_id from members where role = 'owner' and status = 'active' order by created_at limit 1")).rows[0];
    if (!floor || !department) throw new ControlError("invalid_request", `no such room: ${roomId}`);
    if (!owner) throw new ControlError("not_permitted", "the tenant has no active owner");
    return { businessId: floor.business_id as string, department, ownerId: owner.member_id as string };
  });
}

export interface RoomSettings {
  settings: OutreachSettings;
  /** "HH:MM" in the tenant's time zone, or null when the room is not scheduled. */
  dailyAt: string | null;
  /** The day's allowance of test enquiries. null: none set, so none can be sent. */
  enquiriesPerDay: number | null;
  /** 1: stored only, nothing is sent. 2: each needs Salekh's yes. 3: sent, and he is told. */
  enquiryRung: number;
}

export async function readOutreachSettings(db: Db, tenantId: string, roomId: string): Promise<RoomSettings> {
  const room = await roomAndOwner(db, tenantId, roomId);
  return db.tx(tenantId, async (tx) => {
    const stored = await readCurrent(tx, { businessId: room.businessId, kind: "setting", key: room.department });
    const schedule = await readCurrent(tx, { businessId: room.businessId, kind: "schedule", key: room.department });
    const cap = await readCurrent(tx, { businessId: room.businessId, kind: "cap", key: ENQUIRY_CAP });
    return {
      settings: parseOutreachSettings(stored?.value ?? {}), dailyAt: typeof schedule?.value?.daily_at === "string" ? schedule.value.daily_at : null,
      enquiriesPerDay: Number.isFinite(Number(cap?.value?.limit)) ? Number(cap?.value?.limit) : null,
      enquiryRung: await readRung(tx, room.businessId, ENQUIRY_ACTION),
    };
  });
}

const touchesSetting = (c: SettingsChange) => c.areasPerRun !== undefined || c.batchSize !== undefined || Boolean(c.excludeGroups?.length || c.includeGroups?.length || c.enableTypes?.length || c.disableTypes?.length);

export interface SettingsChange {
  areasPerRun?: number;
  batchSize?: number;
  /** Groups to add to the excluded list. */
  excludeGroups?: string[];
  /** Groups to take off it. */
  includeGroups?: string[];
  /** "HH:MM" to run daily at that time, "off" to stop. */
  dailyAt?: string;
  /** The day's allowance of test enquiries (the gateway's cap). */
  enquiriesPerDay?: number;
  /** Let test enquiries be put forward for approval: moves the action from rung 1 (recommend only) to rung 2. */
  allowEnquiries?: boolean;
  /** Kinds of business to switch on or off, by id. "all" stands for every kind in the list. */
  enableTypes?: string[];
  disableTypes?: string[];
  /** Which kind the group changes above apply to. Default: clinics. */
  typeId?: string;
}

/** Change the settings as a new version of config, recorded against the tenant's owner. Returns what is now in force. */
export async function changeOutreachSettings(db: Db, tenantId: string, roomId: string, change: SettingsChange): Promise<RoomSettings> {
  const room = await roomAndOwner(db, tenantId, roomId);
  const current = await db.tx(tenantId, async (tx) => ({
    setting: (await readCurrent(tx, { businessId: room.businessId, kind: "setting", key: room.department }))?.value ?? {},
    schedule: (await readCurrent(tx, { businessId: room.businessId, kind: "schedule", key: room.department }))?.value ?? {},
  }));
  const before = parseOutreachSettings(current.setting);
  // Always written in the current shape: a value stored before there was more than one kind of business is brought up to date here.
  const next = toStoredForm(before) as Record<string, any>;
  const types = (next.business_types as BusinessType[]).map((t) => ({ ...t }));
  next.business_types = types;
  const typeById = (id: string) => {
    const found = types.find((t) => t.id === id);
    if (!found) throw new ControlError("invalid_request", `there is no kind of business with the id "${id}". The kinds are: ${types.map((t) => t.id).join(", ")}`);
    return found;
  };
  for (const [ids, on] of [[change.enableTypes ?? [], true], [change.disableTypes ?? [], false]] as const) {
    for (const id of ids) {
      if (id === "all") for (const t of types) t.enabled = on;
      else typeById(id).enabled = on;
    }
  }
  if (change.areasPerRun !== undefined) next.areas_per_run = change.areasPerRun;
  if (change.batchSize !== undefined) next.find_per_run = change.batchSize;
  if (change.excludeGroups?.length || change.includeGroups?.length) {
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const target = typeById(change.typeId ?? FIRST_TYPE_ID);
    const kept = target.excluded_groups.filter((g) => !(change.includeGroups ?? []).some((x) => same(x, g)));
    const added = (change.excludeGroups ?? []).map((g) => g.trim()).filter((g) => g && !kept.some((k) => same(k, g)));
    target.excluded_groups = [...kept, ...added];
  }
  // Compared with keys in a fixed order: the database does not keep the order a value was written in. A change to
  // the settings also writes them back in the current shape, if they were stored in an older one.
  const settingChanged = canonicalJson(next) !== canonicalJson(toStoredForm(before)) || (touchesSetting(change) && canonicalJson(next) !== canonicalJson(current.setting));
  if (settingChanged) {
    parseOutreachSettings(next); // refuse nonsense before it is stored
    await setConfig(db, { tenantId, businessId: room.businessId, kind: "setting", key: room.department, value: next, memberId: room.ownerId, reason: "changed from the command line" });
  }
  if (change.dailyAt !== undefined) {
    const schedule: Record<string, unknown> = { ...current.schedule };
    if (change.dailyAt === "off") delete schedule.daily_at;
    else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(change.dailyAt)) schedule.daily_at = change.dailyAt;
    else throw new ControlError("invalid_request", "the daily time must be written HH:MM, or off");
    await setConfig(db, { tenantId, businessId: room.businessId, kind: "schedule", key: room.department, value: schedule, memberId: room.ownerId, reason: "changed from the command line" });
  }
  if (change.enquiriesPerDay !== undefined) {
    if (!Number.isInteger(change.enquiriesPerDay) || change.enquiriesPerDay < 0 || change.enquiriesPerDay > 500) throw new ControlError("invalid_request", "the daily allowance must be a whole number from 0 to 500");
    await setConfig(db, { tenantId, businessId: room.businessId, kind: "cap", key: ENQUIRY_CAP, value: { limit: change.enquiriesPerDay }, memberId: room.ownerId, reason: "changed from the command line" });
  }
  if (change.allowEnquiries) {
    const rung = await db.tx(tenantId, (tx) => readRung(tx, room.businessId, ENQUIRY_ACTION));
    // One rung at a time, and only up to "act with approval": this command never takes it further.
    if (rung === 1) await promoteRung(db, actionTypes, { tenantId, businessId: room.businessId, actionType: ENQUIRY_ACTION, memberId: room.ownerId, reason: "test enquiries allowed, each needing approval" });
  }
  return readOutreachSettings(db, tenantId, roomId);
}

/** Add a website or a Companies House number to the permanent list of who must never be contacted. */
export async function suppress(db: Db, tenantId: string, value: string, reason: string): Promise<{ kind: "domain" | "company_number"; added: boolean }> {
  if (!reason?.trim()) throw new ControlError("invalid_request", "a reason is needed: it is kept with the suppression for good");
  const text = String(value ?? "").trim();
  const kind = companyNumberKey(text) && !text.includes(".") ? "company_number" : "domain";
  if (kind === "domain" && !domainKey(text)) throw new ControlError("invalid_request", "give a website (for example example.co.uk) or a Companies House number");
  const owner = await db.tx(tenantId, async (tx) => (await tx.query("select member_id from members where role = 'owner' and status = 'active' order by created_at limit 1")).rows[0]);
  if (!owner) throw new ControlError("not_permitted", "the tenant has no active owner");
  const { added } = await addSuppression(db, { tenantId, businessId: null, kind, value: text, reason: reason.trim(), source: "manual", memberId: owner.member_id });
  return { kind, added };
}

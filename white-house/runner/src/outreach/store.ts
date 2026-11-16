import { z } from "zod";
import type { CompaniesHouseConnector, CompanyResult } from "../control/connectors/companies-house.js";
import { lock, type Db, type Tx } from "../control/db.js";
import { ControlError } from "../control/errors.js";
import { tenantDay } from "../control/runs.js";
import { companyNumberKey, domainKey, hostKey, nameKey, namePostcodeHash, namesNearlyMatch, postcodeKey } from "./normalise.js";
import type { Place } from "../control/connectors/places.js";
import { captureFor, sayMinutes, serviceFor, type TestResult } from "./enquiry-rules.js";
import { applyFilters, isGroup, scoreProspect, type Analysis, type Draft, type Scorable } from "./score.js";
import { FIRST_TYPE_ID, forType } from "./settings.js";
import { SIGNALS, type OutreachSettings } from "./settings.js";

/**
 * The master list in the database. Everything here runs as the gateway's
 * role: agent tools have no access to these tables. Deduplication and the
 * suppression check happen here, in code, under a lock per floor.
 */

export interface ProspectScope {
  tenantId: string;
  businessId: string;
  runId: string | null;
}

/** How long a filtered out prospect keeps its details. */
export const PURGE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const httpUrl = z.string().max(2000).refine((value) => /^https?:\/\/[^\s]+$/i.test(value) && hostKey(value) !== null, "not a web address");

export const foundShape = {
  name: z.string().trim().min(1).max(200).describe("The business's name as it writes it."),
  website: z.string().max(500).optional().describe("The business's own website, if it has one."),
  postcode: z.string().max(12).optional().describe("The postcode of its premises, if published."),
  area: z.string().max(100).optional().describe("Town or district."),
  signal: z.enum([...SIGNALS, "none"]).describe("The signal seen, or none."),
  evidence: z.string().max(300).optional().describe("What you saw, in a few plain words. No names of people."),
  source_url: httpUrl.describe("The public page where you saw the signal."),
  companies_house_number: z.string().max(12).optional().describe("Only if the business prints it."),
};
const foundSchema = z.object(foundShape);
export type FoundInput = z.infer<typeof foundSchema>;

export type RecordResult = { recorded: true; prospectId: string } | { recorded: false; why: "already_known" | "suppressed" | "invalid"; detail?: string };

async function isSuppressed(tx: Tx, businessId: string, keys: { domain: string | null; company: string | null; hash: string | null }): Promise<boolean> {
  const found = await tx.query(
    `select 1 from suppressions
      where (business_id is null or business_id = $1)
        and ((kind = 'domain' and value_key = $2) or (kind = 'company_number' and value_key = $3) or (kind = 'name_postcode' and value_key = $4))
      limit 1`,
    [businessId, keys.domain, keys.company, keys.hash],
  );
  return found.rows.length > 0;
}

/**
 * Add a business to the master list, unless it is suppressed or already
 * there. "Already there" means the same website host, the same Companies
 * House number, the same name at the same postcode, or a near identical name
 * at the same postcode.
 */
export async function recordProspect(db: Db, scope: ProspectScope, input: unknown, opts: { now: Date; sourceOpened?: boolean; searchArea?: string; advertAgeDays?: number; place?: Place; typeId?: string }): Promise<RecordResult> {
  const parsed = foundSchema.safeParse(input);
  if (!parsed.success) return { recorded: false, why: "invalid", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const p = parsed.data;
  const keys = {
    domain: domainKey(p.website ?? null),
    company: companyNumberKey(p.companies_house_number ?? null),
    postcode: postcodeKey(p.postcode ?? null),
    name: nameKey(p.name),
    hash: namePostcodeHash(p.name, p.postcode ?? null),
  };
  // Without its own website or a name at a postcode there is no way to recognise it next time.
  if (!keys.name || (!keys.domain && !keys.hash)) {
    return { recorded: false, why: "invalid", detail: "a prospect needs its own website, or its name with a postcode" };
  }
  const signal = p.signal === "none" ? null : { signal: p.signal, evidence: p.evidence ?? "", source_url: p.source_url, source_opened: opts.sourceOpened === true, seen_on: opts.now.toISOString().slice(0, 10), ...(opts.advertAgeDays === undefined ? {} : { advert_age_days: opts.advertAgeDays }) };

  return db.tx(scope.tenantId, async (tx): Promise<RecordResult> => {
    await lock(tx, "prospects", scope.tenantId, scope.businessId);
    if (await isSuppressed(tx, scope.businessId, keys)) return { recorded: false, why: "suppressed" };

    const same = await tx.query(
      `select prospect_id, signals, purged_at, place_id from prospects
        where business_id = $1 and (domain_key = $2 or companies_house_number = $3 or name_postcode_hash = $4 or place_id = $5)
        limit 1`,
      [scope.businessId, keys.domain, keys.company, keys.hash, opts.place?.id ?? null],
    );
    const placeFacts = opts.place ? JSON.stringify(placeFactsOf(opts.place, opts.now)) : null;
    let existing = same.rows[0];
    if (!existing && keys.postcode) {
      const nearby = await tx.query(
        "select prospect_id, signals, purged_at, name_key, place_id from prospects where business_id = $1 and postcode_key = $2 and name_key is not null",
        [scope.businessId, keys.postcode],
      );
      existing = nearby.rows.find((row) => namesNearlyMatch(row.name_key as string, keys.name as string));
    }
    if (existing) {
      // A new signal for a business already on the list is kept with it.
      const known = signal === null || (existing.signals as { signal: string; unconfirmed?: boolean }[]).some((s) => s.signal === signal.signal && s.unconfirmed !== true);
      if (!known && existing.purged_at === null) {
        await tx.query("update prospects set signals = signals || $2::jsonb where prospect_id = $1", [existing.prospect_id, JSON.stringify([signal])]);
      }
      // A business found earlier another way gains its place id and what Places says about it.
      if (opts.place && existing.place_id === null && existing.purged_at === null) {
        await tx.query("update prospects set place_id = $2, places = $3::jsonb where prospect_id = $1", [existing.prospect_id, opts.place.id, placeFacts]);
      }
      return { recorded: false, why: "already_known" };
    }

    const inserted = await tx.query(
      `insert into prospects
         (tenant_id, business_id, name, area, postcode, website, domain_key, companies_house_number, name_key, postcode_key,
          name_postcode_hash, signals, found_run_id, found_at, search_area, place_id, places, business_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::jsonb, $18)
       returning prospect_id`,
      [scope.tenantId, scope.businessId, p.name, p.area ?? null, p.postcode ?? null, p.website ?? null, keys.domain, keys.company,
       keys.name, keys.postcode, keys.hash, JSON.stringify(signal ? [signal] : []), scope.runId, opts.now, opts.searchArea ?? p.area ?? null,
       opts.place?.id ?? null, placeFacts, opts.typeId ?? FIRST_TYPE_ID],
    );
    const prospectId = inserted.rows[0].prospect_id as string;
    await addEvent(tx, scope, prospectId, "found", p.signal === "none" ? "no_signal_yet" : p.signal, opts.now);
    return { recorded: true, prospectId };
  });
}

/** The website of a business already on the list for this place whose name is all but the same, or null. One match only: two is a guess. */
export async function knownSiteByName(db: Db, scope: ProspectScope, name: string, area: string): Promise<string | null> {
  const key = nameKey(name);
  if (!key) return null;
  return db.tx(scope.tenantId, async (tx) => {
    const rows = (await tx.query(
      "select name_key, website from prospects where business_id = $1 and search_area = $2 and website is not null and name_key is not null and purged_at is null",
      [scope.businessId, area],
    )).rows.filter((r) => namesNearlyMatch(r.name_key as string, key));
    return rows.length === 1 ? (rows[0].website as string) : null;
  });
}

/** What is kept from Places about a business. Facts about the business only: no review text, no reviewer. */
export interface PlaceFacts {
  rating: number | null;
  review_count: number | null;
  phone: string | null;
  address: string | null;
  location: { lat: number; lng: number } | null;
  opening_hours: Place["openingHours"];
  source_url: string;
  fetched_on: string;
}
function placeFactsOf(place: Place, now: Date): PlaceFacts {
  return {
    rating: place.rating, review_count: place.reviewCount, phone: place.phone, address: place.address, location: place.location,
    opening_hours: place.openingHours, source_url: place.sourceUrl, fetched_on: now.toISOString().slice(0, 10),
  };
}

/** Where a business is, by Places, and whether its rivals have been chosen yet. */
export async function placeOf(db: Db, scope: ProspectScope, prospectId: string): Promise<{ placeId: string | null; location: { lat: number; lng: number } | null; hasRivals: boolean } | null> {
  return db.tx(scope.tenantId, async (tx) => {
    const row = (await tx.query(
      "select place_id, places, exists (select 1 from prospect_competitors c where c.prospect_id = p.prospect_id) as has_rivals from prospects p where prospect_id = $1 and business_id = $2",
      [prospectId, scope.businessId],
    )).rows[0];
    return row ? { placeId: row.place_id, location: (row.places as PlaceFacts | null)?.location ?? null, hasRivals: row.has_rivals } : null;
  });
}

/** Make these places, nearest first, the rivals of a prospect: up to three that are on the list and are not set aside as groups or mismatches. */
export async function linkNearest(db: Db, scope: ProspectScope, prospectId: string, placeIds: string[], now: Date): Promise<number> {
  if (placeIds.length === 0) return 0;
  return db.tx(scope.tenantId, async (tx) => {
    const rows = (await tx.query(
      `select prospect_id, place_id from prospects
        where business_id = $1 and place_id = any ($2) and prospect_id <> $3 and purged_at is null
          and business_type = (select business_type from prospects where prospect_id = $3)
          and coalesce(filter_reason, '') not in ('not_a_match', 'duplicate', 'suppressed', 'part_of_group', 'no_website')`,
      [scope.businessId, placeIds, prospectId],
    )).rows;
    const nearest = placeIds.map((id) => rows.find((r) => r.place_id === id)).filter((r) => r !== undefined).slice(0, 3);
    for (const [index, r] of nearest.entries()) {
      await tx.query(
        `insert into prospect_competitors (tenant_id, business_id, prospect_id, competitor_id, comparison, created_at) values ($1, $2, $3, $4, '{}'::jsonb, $5)
         on conflict (tenant_id, prospect_id, competitor_id) do nothing`,
        [scope.tenantId, scope.businessId, prospectId, r.prospect_id, new Date(now.getTime() + index)],
      );
    }
    return nearest.length;
  });
}

async function addEvent(tx: Tx, scope: ProspectScope, prospectId: string, stage: string, reason: string, now: Date): Promise<void> {
  await tx.query(
    "insert into prospect_events (tenant_id, business_id, prospect_id, stage, reason, run_id, created_at) values ($1, $2, $3, $4, $5, $6, $7)",
    [scope.tenantId, scope.businessId, prospectId, stage, reason, scope.runId, now],
  );
}

async function filterOut(tx: Tx, scope: ProspectScope, prospectId: string, reason: string, now: Date): Promise<void> {
  await tx.query(
    "update prospects set stage = 'filtered_out', filter_reason = $2, filtered_out_at = $3, purge_after = $4 where prospect_id = $1",
    [prospectId, reason, now, new Date(now.getTime() + PURGE_AFTER_MS)],
  );
  await addEvent(tx, scope, prospectId, "filtered_out", reason, now);
}

// ---- analysis --------------------------------------------------------------

const NOT_FOUND = z.literal("not found");
const fact = z.union([NOT_FOUND, z.object({ value: z.string().trim().min(1).max(300), source_url: httpUrl })]);
const counted = z.union([NOT_FOUND, z.object({ count: z.number().int().min(0).max(100000), source_url: httpUrl })]);

/** Every field must be given. "not found" is always an acceptable answer; a guess never is. */
export const analysisShape = {
  what_they_sell: fact.describe('What the business sells, in a few words, or "not found".'),
  highest_value_service: fact.describe('Its most expensive or most prominent service, or "not found".'),
  staff_count: counted.describe('How many staff it names or states, or "not found". Count only what the page shows.'),
  locations: counted.describe('How many premises it has, or "not found".'),
  runs_ads: z.union([NOT_FOUND, z.object({ value: z.enum(["yes", "no"]), source_url: httpUrl })]).describe('Whether adverts were seen running, with the page that shows it, or "not found".'),
  reviews: z.union([NOT_FOUND, z.object({ count: z.number().int().min(0), rating: z.number().min(0).max(5), source_url: httpUrl })]).describe('Review count and average rating from one named source, or "not found". Never the text of a review.'),
  enquiry_routes: z
    .array(z.object({
      kind: z.enum(["form", "whatsapp", "instagram", "facebook", "email", "phone", "booking", "other"]),
      value: z.string().trim().min(1).max(300).describe("The link, address or number the business publishes for enquiries."),
      source_url: httpUrl,
    }))
    .max(20)
    .describe("Every way a customer can enquire that the business itself publishes. Empty if none found."),
  contact_person: z
    .union([NOT_FOUND, z.object({ name: z.string().trim().min(1).max(120), role: z.string().trim().min(1).max(120), source_url: httpUrl })])
    .describe('The owner or manager, ONLY if named on the business\'s own website or on Companies House. Otherwise "not found".'),
  company_number: fact.describe('The Companies House number, only if the business prints it, or "not found".'),
  legal_form: z.union([NOT_FOUND, z.object({ value: z.enum(["limited_company", "sole_trader", "partnership", "other"]), source_url: httpUrl })]).describe('What the business says it is, or "not found".'),
  postcode: fact.describe('The postcode of its premises, or "not found".'),
  group: fact.optional().describe('The corporate group or chain it is part of, if a page says so, or "not found".'),
  target_service: fact.optional().describe('Which of the kind\'s target services the pages show the business offers, or "not found".'),
  highest_value_price: z.union([NOT_FOUND, z.object({ amount: z.number().positive().max(1_000_000), source_url: httpUrl })]).optional()
    .describe('The price in pounds the business publishes for its highest value service, or "not found".'),
  opening_hours: fact.optional().describe('Opening hours as the business publishes them, or "not found".'),
  website_built_by: fact.optional().describe('The agency credited in the site footer ("website by"), if any.'),
};
const analysisSchema = z.object(analysisShape);
export type AnalysisInput = z.infer<typeof analysisSchema>;

const COMPANIES_HOUSE_HOST = "company-information.service.gov.uk";
const onHost = (address: string, host: string): boolean => {
  const from = hostKey(address);
  return from !== null && (from === host || from.endsWith(`.${host}`));
};

export type AnalysisResult = { ok: true; note?: string } | { ok: false; why: string };

/**
 * Store the analysis of one prospect, check it against Companies House with
 * plain code, and move it to "analysed". Rules enforced here, whatever the
 * agent sent:
 *   - a person's name is kept only when its source is the business's own
 *     site or Companies House;
 *   - "limited company: yes" only ever comes from Companies House.
 */
export async function recordAnalysis(
  db: Db,
  scope: ProspectScope,
  prospectId: string,
  input: unknown,
  opts: { now: Date; companiesHouse: CompaniesHouseConnector | null },
): Promise<AnalysisResult> {
  const parsed = analysisSchema.safeParse(input);
  if (!parsed.success) return { ok: false, why: `invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  const a = parsed.data;
  const current = await db.tx(scope.tenantId, async (tx) =>
    (await tx.query("select name, postcode, domain_key, companies_house_number, stage, places from prospects where prospect_id = $1 and business_id = $2", [prospectId, scope.businessId])).rows[0]);
  if (!current) return { ok: false, why: "no such prospect" };
  if (current.stage !== "found") return { ok: false, why: "this prospect has already been analysed" };

  const notes: string[] = [];
  let contact = typeof a.contact_person === "object" ? a.contact_person : null;
  if (contact) {
    const ownSite = current.domain_key !== null && onHost(contact.source_url, current.domain_key as string);
    if (!ownSite && !onHost(contact.source_url, COMPANIES_HOUSE_HOST)) {
      contact = null;
      notes.push("The person's name was not kept: its source was neither the business's own website nor Companies House.");
    }
  }
  const stored: Record<string, unknown> = { ...a, contact_person: contact ? { role: contact.role, source_url: contact.source_url } : "not found" };
  // Where Places has spoken, it is the source: its rating and count are measured, a page's own claim is not.
  const g = current.places as PlaceFacts | null;
  const routes = [...a.enquiry_routes];
  if (g) {
    if (g.rating !== null && g.review_count !== null) stored.reviews = { count: Math.round(g.review_count), rating: g.rating, source_url: g.source_url };
    if (g.opening_hours && g.opening_hours.weekday.length > 0) stored.opening_hours = { value: g.opening_hours.weekday.join("; ").slice(0, 300), source_url: g.source_url };
    if (g.phone && !routes.some((r) => r.kind === "phone")) routes.push({ kind: "phone", value: g.phone, source_url: g.source_url });
  }

  const printedNumber = typeof a.company_number === "object" ? companyNumberKey(a.company_number.value) : null;
  const postcode = current.postcode ?? (typeof a.postcode === "object" ? a.postcode.value : null);

  // Companies House, by plain code. The outside call is made with no transaction open.
  let company: CompanyResult | null = null;
  if (opts.companiesHouse) {
    try {
      company = await opts.companiesHouse.lookup({ number: printedNumber ?? current.companies_house_number, name: current.name, postcode });
    } catch {
      company = null; // an outage leaves it unchecked; it does not stop the pipeline
      notes.push("Companies House could not be reached, so the company was not checked.");
    }
  }
  const saysNotLimited = typeof a.legal_form === "object" && (a.legal_form.value === "sole_trader" || a.legal_form.value === "partnership");
  const limited = company?.status === "yes" ? "yes" : saysNotLimited ? "no" : company ? company.status : "not_checked";
  if (!contact && company?.status === "yes" && company.directors?.[0] && company.company) {
    contact = { name: company.directors[0], role: "Director (Companies House register)", source_url: company.company.source_url };
    stored.contact_person = { role: contact.role, source_url: contact.source_url };
  }
  const number = company?.company?.number ?? printedNumber;

  return db.tx(scope.tenantId, async (tx): Promise<AnalysisResult> => {
    await lock(tx, "prospects", scope.tenantId, scope.businessId);
    // Learning the company number or the postcode can show this is a business already on the list.
    const hash = namePostcodeHash(current.name, postcode);
    const clash = await tx.query(
      "select 1 from prospects where business_id = $1 and prospect_id <> $2 and (companies_house_number = $3 or name_postcode_hash = $4) limit 1",
      [scope.businessId, prospectId, number, hash],
    );
    const duplicate = clash.rows.length > 0;
    await tx.query(
      `update prospects
          set analysis = $2::jsonb, contact_name = $3, contact_role = $4, contact_name_source = $5, contact_routes = $6::jsonb,
              is_limited_company = $7, companies_house = $8::jsonb, analysed_at = $9, stage = 'analysed',
              postcode = coalesce(postcode, $10), postcode_key = coalesce(postcode_key, $11),
              companies_house_number = case when $12 then companies_house_number else coalesce($13, companies_house_number) end,
              name_postcode_hash = case when $12 then name_postcode_hash else coalesce(name_postcode_hash, $14) end
        where prospect_id = $1`,
      [prospectId, JSON.stringify(stored), contact?.name ?? null, contact?.role ?? null, contact?.source_url ?? null, JSON.stringify(routes),
       limited, company?.company ? JSON.stringify(company.company) : null, opts.now, postcode, postcodeKey(postcode), duplicate, number, hash],
    );
    await addEvent(tx, scope, prospectId, "analysed", "analysed", opts.now);
    if (duplicate) await filterOut(tx, scope, prospectId, "duplicate", opts.now);
    return notes.length ? { ok: true, note: notes.join(" ") } : { ok: true };
  });
}

/** Signals seen on the business's own pages during analysis are added to what was found. */
export async function addSignals(db: Db, scope: ProspectScope, prospectId: string, signals: { signal: string; evidence: string; source_url: string }[]): Promise<void> {
  if (signals.length === 0) return;
  await db.tx(scope.tenantId, async (tx) => {
    const row = (await tx.query("select signals from prospects where prospect_id = $1 and business_id = $2 for update", [prospectId, scope.businessId])).rows[0];
    if (!row) return;
    const have = new Set((row.signals as { signal: string }[]).map((s) => s.signal));
    const fresh = signals.filter((s) => !have.has(s.signal) && (SIGNALS as readonly string[]).includes(s.signal)).map((s) => ({ ...s, source_opened: true }));
    if (fresh.length > 0) await tx.query("update prospects set signals = signals || $2::jsonb where prospect_id = $1", [prospectId, JSON.stringify(fresh)]);
  });
}

/** Set a prospect aside with a fixed reason, for example when its pages show it is not the kind of business looked for. */
export async function rejectProspect(db: Db, scope: ProspectScope, prospectId: string, reason: string, now: Date): Promise<void> {
  await db.tx(scope.tenantId, async (tx) => {
    const row = (await tx.query("select stage from prospects where prospect_id = $1 and business_id = $2 for update", [prospectId, scope.businessId])).rows[0];
    if (row && (row.stage === "found" || row.stage === "analysed")) await filterOut(tx, scope, prospectId, reason, now);
  });
}

/** An analysis that failed. Tried once more on a later run, then set aside. */
export async function markAnalysisFailed(db: Db, scope: ProspectScope, prospectId: string, now: Date): Promise<void> {
  await db.tx(scope.tenantId, async (tx) => {
    const updated = await tx.query(
      "update prospects set analysis_attempts = analysis_attempts + 1 where prospect_id = $1 and stage = 'found' returning analysis_attempts",
      [prospectId],
    );
    if ((updated.rows[0]?.analysis_attempts ?? 0) >= 2) await filterOut(tx, scope, prospectId, "analysis_failed", now);
  });
}

/**
 * Put right the analysis attempts that failed through a fault of ours (a request the model refused), not the
 * business's. Businesses still waiting have their count set back to nought. With `restoreFailedSince`, those set
 * aside as "analysis_failed" on or after that moment are put back to waiting as well. Nothing else is touched.
 */
export async function resetAnalysisAttempts(db: Db, input: { tenantId: string; restoreFailedSince?: Date }, now = new Date()): Promise<{ reset: number; restored: number }> {
  return db.tx(input.tenantId, async (tx) => {
    const reset = (await tx.query("update prospects set analysis_attempts = 0 where stage = 'found' and analysis_attempts > 0 and purged_at is null")).rowCount ?? 0;
    let restored = 0;
    if (input.restoreFailedSince) {
      const rows = (await tx.query(
        `update prospects set stage = 'found', filter_reason = null, filtered_out_at = null, purge_after = null, analysis_attempts = 0
          where stage = 'filtered_out' and filter_reason = 'analysis_failed' and filtered_out_at >= $1 and purged_at is null
          returning prospect_id, business_id`,
        [input.restoreFailedSince],
      )).rows;
      restored = rows.length;
      for (const r of rows) {
        await tx.query("insert into prospect_events (tenant_id, business_id, prospect_id, stage, reason, run_id, created_at) values ($1, $2, $3, 'found', 'restored_after_request_error', null, $4)",
          [input.tenantId, r.business_id, r.prospect_id, now]);
      }
    }
    return { reset, restored };
  });
}

export interface ProspectRow {
  prospectId: string;
  name: string;
  area: string | null;
  postcode: string | null;
  website: string | null;
  signals: { signal: string; evidence: string; source_url: string; source_opened: boolean; seen_on?: string; advert_age_days?: number; unconfirmed?: boolean }[];
  analysis: (Analysis & Record<string, any>) | null;
  contactName: string | null;
  contactRole: string | null;
  contactNameSource: string | null;
  routes: { kind: string; value: string; source_url: string }[];
  isLimitedCompany: Scorable["isLimitedCompany"];
  companiesHouse: { name: string; number: string; source_url: string; matched_by: string } | null;
  score: number | null;
  breakdown: Record<string, unknown> | null;
  card: (Draft & { lead_agent: string } & Record<string, any>) | null;
  /** Why no test enquiry can be sent to it, when that is so. */
  notTestableReason: string | null;
  /** What Google Places said about it when it was found, if it was found that way. */
  places: PlaceFacts | null;
  /** Which kind of business it is: an id from the settings' list. */
  typeId: string;
}

const COLUMNS =
  "prospect_id, name, area, postcode, website, signals, analysis, contact_name, contact_role, contact_name_source, contact_routes, is_limited_company, companies_house, score, score_breakdown, card, not_testable_reason, places, business_type";

const toRow = (r: any): ProspectRow => ({
  prospectId: r.prospect_id, name: r.name, area: r.area, postcode: r.postcode, website: r.website, signals: r.signals, analysis: r.analysis,
  contactName: r.contact_name, contactRole: r.contact_role, contactNameSource: r.contact_name_source, routes: r.contact_routes,
  isLimitedCompany: r.is_limited_company, companiesHouse: r.companies_house, score: r.score === null ? null : Number(r.score), breakdown: r.score_breakdown, card: r.card, notTestableReason: r.not_testable_reason ?? null, places: r.places ?? null, typeId: r.business_type ?? FIRST_TYPE_ID,
});

/** How many businesses are found and still waiting to be analysed. */
export function countWaiting(db: Db, scope: { tenantId: string; businessId: string }): Promise<number> {
  return db.tx(scope.tenantId, async (tx) =>
    (await tx.query("select count(*)::int as n from prospects where business_id = $1 and stage = 'found'", [scope.businessId])).rows[0].n as number);
}

/** Found and not yet analysed: today's finds and anything left from an earlier run. */
export function listForAnalysis(db: Db, scope: ProspectScope, limit: number): Promise<ProspectRow[]> {
  return db.tx(scope.tenantId, async (tx) =>
    (await tx.query(
      // Those found from a front desk advert first: they are the ones most likely to pass. The rest fill the batch.
      `select ${COLUMNS} from prospects where business_id = $1 and stage = 'found'
        order by (signals @> '[{"signal": "hiring_front_desk"}]'::jsonb) desc, found_at, prospect_id limit $2`,
      [scope.businessId, limit],
    )).rows.map(toRow));
}

/**
 * Apply the suppression list, the filter rules and the score to every
 * analysed prospect that has no card yet. Returns what was filtered out, by
 * reason, and those that passed, best first.
 */
export async function scoreAndFilter(db: Db, scope: ProspectScope, settings: OutreachSettings, now: Date): Promise<{ considered: number; filtered: Record<string, number>; passed: ProspectRow[]; wouldPassWithCompaniesHouse: number }> {
  return db.tx(scope.tenantId, async (tx) => {
    await lock(tx, "prospects", scope.tenantId, scope.businessId);
    const rows = await tx.query(
      `select ${COLUMNS}, domain_key, companies_house_number, name_postcode_hash from prospects
        where business_id = $1 and stage = 'analysed' order by found_at, prospect_id`,
      [scope.businessId],
    );
    const filtered: Record<string, number> = {};
    const passed: ProspectRow[] = [];
    let wouldPassWithCompaniesHouse = 0;
    for (const raw of rows.rows) {
      const p = toRow(raw);
      const scorable: Scorable = {
        name: p.name, website: p.website, companyName: p.companiesHouse?.name ?? null,
        // A match that is only a guess never counts towards passing or towards the score.
        signals: p.signals.filter((s) => s.unconfirmed !== true).map((s) => s.signal),
        analysis: p.analysis, contactName: p.contactName, routes: p.routes, isLimitedCompany: p.isLimitedCompany,
      };
      const suppressed = await isSuppressed(tx, scope.businessId, { domain: raw.domain_key, company: raw.companies_house_number, hash: raw.name_postcode_hash });
      // Its own kind's groups and rules.
      const own = forType(settings, p.typeId);
      const verdict = suppressed ? { keep: false as const, reason: "suppressed" } : applyFilters(scorable, own);
      if (!verdict.keep) {
        // What a Companies House key is worth: with no key no director's name can be looked up, so count those
        // that failed only for want of a named person and would otherwise have passed.
        if (verdict.reason === "no_named_contact" && p.isLimitedCompany === "not_checked" && applyFilters({ ...scorable, contactName: "(a director, if the register has one)" }, settings).keep) {
          wouldPassWithCompaniesHouse += 1;
        }
        await filterOut(tx, scope, p.prospectId, verdict.reason, now);
        filtered[verdict.reason] = (filtered[verdict.reason] ?? 0) + 1;
        continue;
      }
      const { score, breakdown } = scoreProspect(scorable, settings);
      await tx.query("update prospects set score = $2, score_breakdown = $3::jsonb where prospect_id = $1", [p.prospectId, score, JSON.stringify(breakdown)]);
      passed.push({ ...p, score, breakdown: { ...breakdown } });
    }
    passed.sort((x, y) => (y.score as number) - (x.score as number));
    return { considered: rows.rows.length, filtered, passed, wouldPassWithCompaniesHouse };
  });
}

/** Save the drafted card and move the prospect to the shortlist. A card for a business already shortlisted replaces its card (a reissue). */
export async function saveCard(db: Db, scope: ProspectScope, prospectId: string, card: Record<string, unknown>, now: Date): Promise<void> {
  await db.tx(scope.tenantId, async (tx) => {
    const row = (await tx.query("select stage from prospects where prospect_id = $1 and business_id = $2 for update", [prospectId, scope.businessId])).rows[0];
    if (!row || !["analysed", "tested", "shortlisted"].includes(row.stage)) return;
    await tx.query(
      "update prospects set card = $2::jsonb, stage = 'shortlisted', shortlisted_at = coalesce(shortlisted_at, $3) where prospect_id = $1",
      [prospectId, JSON.stringify({ ...card, drafted_at: now.toISOString() }), now],
    );
    if (row.stage !== "shortlisted") await addEvent(tx, scope, prospectId, "shortlisted", "passed_filters", now);
  });
}

/** Prospects by id, in the order asked for. */
export function prospectsByIds(db: Db, scope: ProspectScope, ids: string[]): Promise<ProspectRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return db.tx(scope.tenantId, async (tx) => {
    const rows = (await tx.query(`select ${COLUMNS} from prospects where business_id = $1 and prospect_id = any ($2) and purged_at is null`, [scope.businessId, ids])).rows.map(toRow);
    return ids.map((id) => rows.find((r) => r.prospectId === id)).filter((r): r is ProspectRow => r !== undefined);
  });
}

export { COLUMNS as PROSPECT_COLUMNS, toRow as toProspectRow };

/**
 * With test enquiries on, sort the analysed businesses that have no enquiry yet. THE TEST COMES FIRST: nothing
 * about a business's company or who runs it stops it being tested.
 *   - suppressed, or part of a group                            filtered out, with the reason
 *   - matches its kind and publishes an email                   returned in `toTest`, best fit first
 *   - cannot be tested by email                                 marked not testable; shortlisted only if it shows a
 *                                                              confirmed signal and passes the other filters (the rule
 *                                                              before tests), except that a named person is not required
 */
export async function triageAnalysed(
  db: Db, scope: ProspectScope, settings: OutreachSettings, now: Date, notTestable: (p: ProspectRow, s: Scorable) => string | null,
): Promise<{ considered: number; filtered: Record<string, number>; toTest: ProspectRow[]; passedUntested: ProspectRow[]; wouldPassWithCompaniesHouse: number }> {
  return db.tx(scope.tenantId, async (tx) => {
    await lock(tx, "prospects", scope.tenantId, scope.businessId);
    const rows = await tx.query(
      `select ${COLUMNS}, domain_key, companies_house_number, name_postcode_hash from prospects p
        where business_id = $1 and stage = 'analysed'
          and not exists (select 1 from enquiries e where e.prospect_id = p.prospect_id and e.status not in ('rejected', 'expired'))
        order by found_at, prospect_id`,
      [scope.businessId],
    );
    const filtered: Record<string, number> = {};
    const toTest: ProspectRow[] = [];
    const passedUntested: ProspectRow[] = [];
    for (const raw of rows.rows) {
      const p = toRow(raw);
      const own = forType(settings, p.typeId);
      const scorable: Scorable = {
        name: p.name, website: p.website, companyName: p.companiesHouse?.name ?? null,
        signals: p.signals.filter((s) => s.unconfirmed !== true).map((s) => s.signal),
        analysis: p.analysis, contactName: p.contactName, routes: p.routes, isLimitedCompany: p.isLimitedCompany,
      };
      const out = async (reason: string) => {
        await filterOut(tx, scope, p.prospectId, reason, now);
        filtered[reason] = (filtered[reason] ?? 0) + 1;
      };
      if (await isSuppressed(tx, scope.businessId, { domain: raw.domain_key, company: raw.companies_house_number, hash: raw.name_postcode_hash })) { await out("suppressed"); continue; }
      if (own.filters.exclude_groups && isGroup(scorable, own)) { await out("part_of_group"); continue; }
      const { score, breakdown } = scoreProspect(scorable, own);
      await tx.query("update prospects set score = $2, score_breakdown = $3::jsonb where prospect_id = $1", [p.prospectId, score, JSON.stringify(breakdown)]);
      const scored = { ...p, score, breakdown: { ...breakdown } };
      const why = (raw.not_testable_reason as string | null) ?? notTestable(p, scorable);
      // The right trade is not enough for a kind that is looked for by its services: a solicitor that does neither
      // conveyancing nor family law is not what is being looked for, and is not written to.
      if (own.type.require_target_service && serviceFor(p.analysis, own) === null) { await out("not_a_target_service"); continue; }
      if (why === null) { toTest.push(scored); continue; }
      await tx.query("update prospects set not_testable_reason = $2 where prospect_id = $1", [p.prospectId, why]);
      scored.notTestableReason = why;
      // Not testable: the test cannot be its signal, so it needs one of the others and must pass the filters now.
      const fit = applyFilters(scorable, { ...own, filters: { ...own.filters, require_named_contact: false } });
      if (!fit.keep) await out(fit.reason);
      else passedUntested.push(scored);
    }
    const byFit = (a: ProspectRow, b: ProspectRow) => (b.score as number) - (a.score as number);
    return { considered: rows.rows.length, filtered, toTest: toTest.sort(byFit), passedUntested: passedUntested.sort(byFit), wouldPassWithCompaniesHouse: 0 };
  });
}

/**
 * Tested businesses that are due to be scored and whose company has not been confirmed. Looked up at Companies
 * House only now, after the test, and only by the caller for those that scored low.
 */
export async function awaitingCompanyCheck(db: Db, scope: ProspectScope, dueBefore: Date): Promise<(ProspectRow & { testResult: unknown; companyNumber: string | null })[]> {
  return db.tx(scope.tenantId, async (tx) =>
    (await tx.query(
      `select ${COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")}, p.test_result, p.companies_house_number
         from prospects p join enquiries e on e.prospect_id = p.prospect_id and e.status = 'sent'
        where p.business_id = $1 and p.stage = 'analysed' and p.capture_score is null and e.sent_at <= $2 and p.purged_at is null
          and p.is_limited_company in ('not_found', 'not_checked')`,
      [scope.businessId, dueBefore],
    )).rows.map((r) => ({ ...toRow(r), testResult: r.test_result, companyNumber: r.companies_house_number })));
}

/** Record what Companies House said after the test: whether it is a limited company, and a director's name when no person was named. */
export async function saveCompanyCheck(db: Db, scope: ProspectScope, prospectId: string, result: CompanyResult): Promise<void> {
  await db.tx(scope.tenantId, async (tx) => {
    const row = (await tx.query("select contact_name, analysis from prospects where prospect_id = $1 and business_id = $2 for update", [prospectId, scope.businessId])).rows[0];
    if (!row) return;
    await tx.query("update prospects set is_limited_company = $2, companies_house = $3::jsonb where prospect_id = $1", [prospectId, result.status, result.company ? JSON.stringify(result.company) : null]);
    const director = result.status === "yes" && result.company ? result.directors?.[0] : undefined;
    if (!row.contact_name && director && result.company) {
      const role = "Director (Companies House register)";
      await tx.query(
        "update prospects set contact_name = $2, contact_role = $3, contact_name_source = $4, analysis = jsonb_set(coalesce(analysis, '{}'::jsonb), '{contact_person}', $5::jsonb) where prospect_id = $1",
        [prospectId, director, role, result.company.source_url, JSON.stringify({ role, source_url: result.company.source_url })],
      );
    }
  });
}

/** The two reasons a business used to be dropped for before it was ever tested. Only these can be put back. */
export const RESTORABLE_REASONS = ["no_named_contact", "limited_company_not_confirmed"] as const;

/**
 * Put back to "analysed" the businesses filtered out, since a given moment, for a reason that no longer stops a
 * test. They are then sorted again on the next run like any newly analysed business. One that already has an
 * enquiry, or has been purged, is left alone.
 */
export async function restoreFiltered(db: Db, input: { tenantId: string; reasons: string[]; since: Date }, now = new Date()): Promise<Record<string, number>> {
  const reasons = input.reasons.filter((r) => (RESTORABLE_REASONS as readonly string[]).includes(r));
  if (reasons.length === 0) return {};
  return db.tx(input.tenantId, async (tx) => {
    const rows = (await tx.query(
      `update prospects p set stage = 'analysed', filter_reason = null, filtered_out_at = null, purge_after = null
        where stage = 'filtered_out' and filter_reason = any ($1) and filtered_out_at >= $2 and purged_at is null and analysis is not null
          and not exists (select 1 from enquiries e where e.prospect_id = p.prospect_id)
        returning prospect_id, business_id, (select x.filter_reason from prospects x where x.prospect_id = p.prospect_id) as was`,
      [reasons, input.since],
    )).rows;
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.was as string] = (counts[r.was as string] ?? 0) + 1;
      await tx.query("insert into prospect_events (tenant_id, business_id, prospect_id, stage, reason, run_id, created_at) values ($1, $2, $3, 'analysed', $4, null, $5)",
        [input.tenantId, r.business_id, r.prospect_id, `restored_was_${r.was}`, now]);
    }
    return counts;
  });
}

// ---- where to search next, and local competitors ---------------------------

/**
 * The next few places to search: those never searched first, then the ones
 * searched longest ago, in the order of the list. They are marked as searched
 * now, so the next run moves on.
 */
export interface SearchPair {
  typeId: string;
  area: string;
}

/**
 * The next few (kind, place) pairs to search: the ones searched longest ago first, never searched before any.
 * Among equals the order is place by place, each place for every kind, so over time each kind that is switched
 * on gets every place and no kind is left behind. The pairs returned are marked as searched now.
 */
export async function nextPairs(db: Db, scope: ProspectScope, typeIds: string[], areas: string[], howMany: number, now: Date): Promise<SearchPair[]> {
  if (areas.length === 0 || typeIds.length === 0) return [];
  return db.tx(scope.tenantId, async (tx) => {
    await lock(tx, "coverage", scope.tenantId, scope.businessId);
    const done = await tx.query("select type_id, area, last_searched_at, times_searched from search_coverage where business_id = $1", [scope.businessId]);
    const when = new Map(done.rows.map((r) => [`${r.type_id}|${r.area}`, { last: (r.last_searched_at as Date).getTime(), times: r.times_searched as number }]));
    const all = areas.flatMap((area, a) => typeIds.map((typeId, t) => ({ typeId, area, a, t, last: when.get(`${typeId}|${area}`)?.last ?? -1, times: when.get(`${typeId}|${area}`)?.times ?? 0 })));
    // Pairs searched in the same run share a time, so the count of searches breaks the tie: the one searched least goes first.
    const picked = all.sort((x, y) => x.last - y.last || x.times - y.times || x.a - y.a || x.t - y.t).slice(0, howMany).map(({ typeId, area }) => ({ typeId, area }));
    for (const pair of picked) {
      await tx.query(
        `insert into search_coverage (tenant_id, business_id, type_id, area, last_searched_at) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, business_id, type_id, area) do update set last_searched_at = excluded.last_searched_at, times_searched = search_coverage.times_searched + 1`,
        [scope.tenantId, scope.businessId, pair.typeId, pair.area, now],
      );
    }
    return picked;
  });
}

/** The places to search next, for one kind of business. Kept for the single-kind callers. */
export async function nextAreas(db: Db, scope: ProspectScope, areas: string[], howMany: number, now: Date): Promise<string[]> {
  return (await nextPairs(db, scope, [FIRST_TYPE_ID], areas, howMany, now)).map((p) => p.area);
}

type Sourced<T> = (T & { source_url: string }) | "not found";

/** What is public and checkable about one business, for setting two side by side. */
export interface PublicFacts {
  prospect_id: string;
  name: string;
  website: string | null;
  reviews: Sourced<{ count: number; rating: number }>;
  front_desk_advert: Sourced<{ advertised: true }>;
  /** The kinds of enquiry route it publishes, each with the page that shows one. */
  routes: { kind: string; source_url: string }[];
  opening_hours: Sourced<{ value: string }>;
  /** "scored": an enquiry was sent and the waiting time has passed. "awaiting": sent, too soon to judge. "no": never sent one. */
  tested: "scored" | "awaiting" | "no";
  /** Its capture score, when tested and scored. */
  capture_score: number | null;
  /** Minutes to a person's first reply. null with tested "scored" means nobody replied. */
  reply_minutes: number | null;
}

function publicFacts(r: any, settings: OutreachSettings, timezone: string, now: Date): PublicFacts {
  const a = r.analysis as Record<string, any> | null;
  const advert = (r.signals as { signal: string; source_url: string; unconfirmed?: boolean }[]).find((s) => s.signal === "hiring_front_desk" && s.unconfirmed !== true);
  const kinds = new Map<string, string>();
  for (const route of r.contact_routes as { kind: string; source_url: string }[]) if (!kinds.has(route.kind)) kinds.set(route.kind, route.source_url);
  const test = r.test_result as TestResult | null;
  const due = test ? new Date(test.sent_at).getTime() + settings.reply_wait_hours * 60 * 60 * 1000 <= now.getTime() : false;
  const people = (test?.replies ?? []).filter((x) => x.kind === "person").sort((x, y) => x.received_at.localeCompare(y.received_at));
  return {
    prospect_id: r.prospect_id, name: r.name, website: r.website,
    reviews: typeof a?.reviews === "object" ? a.reviews : "not found",
    front_desk_advert: advert ? { advertised: true, source_url: advert.source_url } : "not found",
    routes: [...kinds].map(([kind, source_url]) => ({ kind, source_url })),
    opening_hours: typeof a?.opening_hours === "object" ? a.opening_hours : "not found",
    tested: !test ? "no" : due ? "scored" : "awaiting",
    capture_score: test && due ? captureFor(test, [...kinds.keys()], settings, timezone).score : null,
    reply_minutes: test && due && people[0] ? (new Date(people[0].received_at).getTime() - new Date(test.sent_at).getTime()) / 60000 : null,
  };
}

/**
 * Up to three local competitors of a prospect: other businesses already on
 * the master list, found by the same searches for the same place, that have
 * been analysed. Those in the same postcode district come first. The link is
 * stored with what was public about each at the time.
 */
export async function linkCompetitors(db: Db, scope: ProspectScope, prospectId: string, now: Date, settings: OutreachSettings): Promise<{ self: PublicFacts; competitors: PublicFacts[] } | null> {
  const COLS = "prospect_id, name, website, analysis, signals, contact_routes, test_result, postcode_key, search_area, business_type";
  return db.tx(scope.tenantId, async (tx) => {
    const self = (await tx.query(`select ${COLS} from prospects where prospect_id = $1 and business_id = $2`, [prospectId, scope.businessId])).rows[0];
    if (!self) return null;
    const timezone = (await tx.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0].timezone as string;
    const facts = (r: any) => publicFacts(r, settings, timezone, now);
    const district = typeof self.postcode_key === "string" ? (self.postcode_key as string).slice(0, -3) : null;
    // Rivals already linked to this prospect stay its rivals, so a card reissued later compares the same businesses.
    const linked = await tx.query(
      `select ${COLS.split(", ").map((c) => `p.${c}`).join(", ")} from prospect_competitors c join prospects p on p.prospect_id = c.competitor_id
        where c.prospect_id = $1 and p.purged_at is null and p.business_type = $2 order by c.created_at, p.name limit 3`,
      [prospectId, self.business_type],
    );
    const others = linked.rows.length > 0 ? linked : self.search_area === null ? { rows: [] as any[] } : await tx.query(
      `select ${COLS} from prospects
        where business_id = $1 and prospect_id <> $2 and search_area = $3 and analysis is not null and purged_at is null
          -- a rival is always the same kind of business
          and business_type = $5
          and coalesce(filter_reason, '') not in ('not_a_match', 'duplicate', 'suppressed', 'part_of_group')
        order by (postcode_key is not null and left(postcode_key, length(postcode_key) - 3) = $4) desc, found_at, name, prospect_id
        limit 3`,
      [scope.businessId, prospectId, self.search_area, district, self.business_type],
    );
    // Shown in the same order every time a card is issued.
    const competitors = others.rows.map(facts).sort((a, b) => a.name.localeCompare(b.name));
    for (const c of competitors) {
      await tx.query(
        `insert into prospect_competitors (tenant_id, business_id, prospect_id, competitor_id, comparison, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         on conflict (tenant_id, prospect_id, competitor_id) do update set comparison = excluded.comparison`,
        [scope.tenantId, scope.businessId, prospectId, c.prospect_id, JSON.stringify(c), now],
      );
    }
    return { self: facts(self), competitors };
  });
}

export interface Comparison {
  /** One Markdown table: a row per fact, a column per business, sources listed once beneath. */
  table: string;
  /** Only the differences that go against the prospect, each a plain statement of fact. */
  unfavourable: string[];
}

/**
 * A prospect set beside its local competitors. Written by code: no adjectives,
 * "not found" where something is not known, and every source listed once.
 */
export function compare(self: PublicFacts, competitors: PublicFacts[]): Comparison | null {
  if (competitors.length === 0) return null;
  const sources: string[] = [];
  const ref = (url: string): string => {
    if (!sources.includes(url)) sources.push(url);
    return ` [${sources.indexOf(url) + 1}]`;
  };
  const all = [self, ...competitors];
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const row = (label: string, each: (f: PublicFacts) => string) => `| ${label} | ${all.map((f) => cell(each(f))).join(" | ")} |`;
  const table = [
    `| | ${all.map((f) => cell(f.name)).join(" | ")} |`,
    `| --- | ${all.map(() => "---").join(" | ")} |`,
    row("Reviews", (f) => (typeof f.reviews === "object" ? `${f.reviews.rating} from ${f.reviews.count}${ref(f.reviews.source_url)}` : "not found")),
    row("Ways to enquire", (f) => (f.routes.length ? f.routes.map((r) => `${r.kind}${ref(r.source_url)}`).join(", ") : "not found")),
    row("Front desk job advert", (f) => (typeof f.front_desk_advert === "object" ? `advert found${ref(f.front_desk_advert.source_url)}` : "not found")),
    row("Opening hours", (f) => (typeof f.opening_hours === "object" ? `${f.opening_hours.value}${ref(f.opening_hours.source_url)}` : "not found")),
    row("Reply to the test enquiry", (f) =>
      !f.tested || f.tested === "no" ? "Not tested yet" : f.tested === "awaiting" ? "Sent, awaiting the wait" : f.reply_minutes === null ? "no reply from a person" : `a person replied in ${sayMinutes(f.reply_minutes)}`),
    row("Capture score", (f) => (f.tested === "scored" && f.capture_score !== null ? `${f.capture_score} out of 100` : "Not tested yet")),
    "",
    "Sources:",
    ...sources.map((url, i) => `${i + 1}. ${url}`),
  ].join("\n");

  const unfavourable: string[] = [];
  for (const c of competitors) {
    const extra = c.routes.map((r) => r.kind).filter((kind) => !self.routes.some((s) => s.kind === kind)).sort();
    if (extra.length) unfavourable.push(`${c.name} publishes ${extra.join(" and ")} for enquiries; ${extra.length > 1 ? "these were" : "this was"} not found for ${self.name}.`);
    if (typeof c.reviews === "object" && typeof self.reviews === "object" && c.reviews.rating > self.reviews.rating) {
      unfavourable.push(`${c.name} shows ${c.reviews.rating} from ${c.reviews.count} reviews; ${self.name} shows ${self.reviews.rating} from ${self.reviews.count}.`);
    }
    if (typeof c.opening_hours === "object" && self.opening_hours === "not found") unfavourable.push(`${c.name} publishes its opening hours; none were found for ${self.name}.`);
    // Measured by the same kind of test enquiry, sent to both.
    if (self.tested === "scored" && c.tested === "scored" && c.reply_minutes !== null && (self.reply_minutes === null || c.reply_minutes < self.reply_minutes)) {
      unfavourable.push(`${c.name} replied to the same kind of enquiry in ${sayMinutes(c.reply_minutes)}; ${self.name} ${self.reply_minutes === null ? "did not reply" : `replied in ${sayMinutes(self.reply_minutes)}`}.`);
    }
  }
  return { table, unfavourable };
}

/**
 * A recruiter's advert that hides the employer: one attempt to tie it to a business already on the list
 * for that place, by postcode. A full postcode in the advert that one business has, or a postcode district
 * with exactly one business on the list, is taken as a possible match. It is stored as UNCONFIRMED: it is
 * shown on a card and never counts towards passing the filters or the score.
 */
export async function matchHiddenAdvert(
  db: Db, scope: ProspectScope, advert: { title: string; url: string; text: string }, searchArea: string, now: Date,
): Promise<boolean> {
  const found = [...advert.text.toUpperCase().matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})?\b/g)];
  const full = found.filter((m) => m[2]).map((m) => `${m[1]}${m[2]}`);
  const districts = found.map((m) => m[1] as string);
  if (found.length === 0) return false;
  return db.tx(scope.tenantId, async (tx) => {
    const rows = await tx.query(
      "select prospect_id, postcode_key, signals from prospects where business_id = $1 and search_area = $2 and postcode_key is not null and purged_at is null",
      [scope.businessId, searchArea],
    );
    let hits = rows.rows.filter((r) => full.includes(r.postcode_key as string));
    if (hits.length === 0) hits = rows.rows.filter((r) => districts.includes((r.postcode_key as string).slice(0, -3)));
    if (hits.length !== 1) return false;
    const hit = hits[0];
    if ((hit.signals as { source_url: string }[]).some((s) => s.source_url === advert.url)) return false;
    const signal = {
      signal: "hiring_front_desk", unconfirmed: true, source_url: advert.url, source_opened: true, seen_on: now.toISOString().slice(0, 10),
      evidence: `UNCONFIRMED. A recruiter's advert that does not name the employer, matched to this business by postcode only: ${advert.title.slice(0, 160) || "untitled"}`,
    };
    await tx.query("update prospects set signals = signals || $2::jsonb where prospect_id = $1", [hit.prospect_id, JSON.stringify([signal])]);
    return true;
  });
}

/** Which of these website keys are already on the list, and which are suppressed. Lets code drop them before any model is asked. */
export async function knownDomains(db: Db, scope: ProspectScope, domains: string[]): Promise<{ known: Set<string>; suppressed: Set<string> }> {
  if (domains.length === 0) return { known: new Set(), suppressed: new Set() };
  return db.tx(scope.tenantId, async (tx) => {
    const known = await tx.query("select domain_key from prospects where business_id = $1 and domain_key = any ($2)", [scope.businessId, domains]);
    const suppressed = await tx.query(
      "select value_key from suppressions where (business_id is null or business_id = $1) and kind = 'domain' and value_key = any ($2)",
      [scope.businessId, domains],
    );
    return { known: new Set(known.rows.map((r) => r.domain_key as string)), suppressed: new Set(suppressed.rows.map((r) => r.value_key as string)) };
  });
}

// ---- suppressions ----------------------------------------------------------

export interface SuppressionInput {
  tenantId: string;
  /** null: on every floor. */
  businessId: string | null;
  kind: "domain" | "company_number" | "email" | "phone" | "name_postcode";
  /** A website, a number, an address, or for name_postcode an object {name, postcode}. */
  value: unknown;
  reason: string;
  source?: "manual" | "opt_out" | "complaint";
  memberId?: string | null;
}

function suppressionKey(kind: SuppressionInput["kind"], value: unknown): string | null {
  switch (kind) {
    case "domain": return domainKey(value) ?? hostKey(value);
    case "company_number": return companyNumberKey(value);
    case "email": return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
    case "phone": {
      const digits = typeof value === "string" ? value.replace(/\D/g, "").replace(/^44/, "0") : "";
      return digits.length >= 7 ? digits : null;
    }
    case "name_postcode": {
      const v = value as { name?: unknown; postcode?: unknown } | null;
      return namePostcodeHash(v?.name, v?.postcode);
    }
  }
}

/** Add to the permanent list of who must never be contacted. Adding the same one twice changes nothing. */
export async function addSuppression(db: Db, input: SuppressionInput): Promise<{ added: boolean }> {
  const key = suppressionKey(input.kind, input.value);
  if (!key) throw new ControlError("invalid_request", `that is not a valid ${input.kind} to suppress`);
  return db.tx(input.tenantId, async (tx) => {
    const inserted = await tx.query(
      `insert into suppressions (tenant_id, business_id, kind, value_key, reason, source, added_by)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (tenant_id, kind, value_key) do nothing`,
      [input.tenantId, input.businessId, input.kind, key, input.reason, input.source ?? "manual", input.memberId ?? null],
    );
    return { added: (inserted.rowCount ?? 0) > 0 };
  });
}

// ---- retention and numbers -------------------------------------------------

/**
 * Clear the details of prospects that were filtered out more than 90 days
 * ago. The row stays, with only what is needed to stop the same business
 * being found again. Returns how many were cleared. Meant to run daily.
 */
export async function purgeProspects(db: Db, input: { tenantId: string }, now = new Date()): Promise<number> {
  return db.tx(input.tenantId, async (tx) => {
    const purged = await tx.query(
      `update prospects
          set name = '(removed)', area = null, postcode = null, website = null, name_key = null,
              signals = '[]'::jsonb, analysis = null, contact_name = null, contact_role = null, contact_name_source = null,
              contact_routes = '[]'::jsonb, companies_house = null, score_breakdown = null, card = null,
              test_result = null, purged_at = $1
        where stage = 'filtered_out' and purged_at is null and purge_after is not null and purge_after <= $1`,
      [now],
    );
    return purged.rowCount ?? 0;
  });
}

const STAGES = ["found", "analysed", "filtered_out", "shortlisted", "tested", "messaged", "replied", "call_booked", "paid", "opted_out"] as const;

export interface ProspectStats {
  from: string;
  to: string;
  stages: Record<(typeof STAGES)[number], number>;
  filtered_out_by_reason: Record<string, number>;
  found_by_signal: Record<string, number>;
  /** Test enquiries in the range, for possible clients and for rivals of those that scored low. */
  enquiries: Record<"prospect" | "rival", EnquiryStats>;  /** The same counts per stage, for each kind of business that has any. */
  by_type: Record<string, Partial<Record<(typeof STAGES)[number], number>>>;
}

export interface EnquiryStats {
  proposed: number;
  approved: number;
  rejected: number;
  sent: number;
  /** Of those sent in the range: a person replied, only a machine replied, nobody replied. */
  replied_person: number;
  replied_automatic: number;
  no_reply: number;
  scored: number;
}

/** Counts per stage for the days from `from` up to, not including, `to` (YYYY-MM-DD, the tenant's days). */
export async function prospectStats(db: Db, input: { tenantId: string; businessId?: string | null; from: string; to: string }): Promise<ProspectStats> {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(input.from) || !day.test(input.to)) throw new ControlError("invalid_request", "dates must be written YYYY-MM-DD");
  return db.tx(input.tenantId, async (tx) => {
    await tenantDay(tx, new Date()); // fails early for an unknown tenant
    const counts = await tx.query(
      `select e.stage, e.reason, count(*)::int as n
         from prospect_events e join tenants t on t.tenant_id = e.tenant_id
        where ($1::uuid is null or e.business_id = $1)
          and (e.created_at at time zone t.timezone)::date >= $2::date
          and (e.created_at at time zone t.timezone)::date < $3::date
        group by e.stage, e.reason`,
      [input.businessId ?? null, input.from, input.to],
    );
    const none = (): EnquiryStats => ({ proposed: 0, approved: 0, rejected: 0, sent: 0, replied_person: 0, replied_automatic: 0, no_reply: 0, scored: 0 });
    const stats: ProspectStats = {
      from: input.from, to: input.to,
      stages: Object.fromEntries(STAGES.map((s) => [s, 0])) as ProspectStats["stages"],
      filtered_out_by_reason: {}, found_by_signal: {},
      enquiries: { prospect: none(), rival: none() },
      by_type: {},
    };
    const byType = await tx.query(
      `select p.business_type, e.stage, count(*)::int as n
         from prospect_events e join tenants t on t.tenant_id = e.tenant_id join prospects p on p.prospect_id = e.prospect_id
        where ($1::uuid is null or e.business_id = $1)
          and (e.created_at at time zone t.timezone)::date >= $2::date
          and (e.created_at at time zone t.timezone)::date < $3::date
        group by p.business_type, e.stage`,
      [input.businessId ?? null, input.from, input.to],
    );
    for (const row of byType.rows) (stats.by_type[row.business_type as string] ??= {})[row.stage as (typeof STAGES)[number]] = row.n as number;
    const inRange = (column: string) => `(${column} at time zone t.timezone)::date >= $2::date and (${column} at time zone t.timezone)::date < $3::date`;
    const enquiries = await tx.query(
      `select e.purpose,
              count(*) filter (where ${inRange("e.proposed_at")})::int as proposed,
              count(*) filter (where e.status in ('approved', 'sending', 'sent', 'failed') and ${inRange("e.decided_at")})::int as approved,
              count(*) filter (where e.status = 'rejected' and ${inRange("e.decided_at")})::int as rejected,
              count(*) filter (where e.status = 'sent' and ${inRange("e.sent_at")})::int as sent,
              count(*) filter (where e.status = 'sent' and ${inRange("e.sent_at")} and p.test_result -> 'replies' @> '[{"kind": "person"}]')::int as replied_person,
              count(*) filter (where e.status = 'sent' and ${inRange("e.sent_at")} and not (p.test_result -> 'replies' @> '[{"kind": "person"}]')
                                 and p.test_result -> 'replies' @> '[{"kind": "automatic"}]')::int as replied_automatic,
              count(*) filter (where e.status = 'sent' and ${inRange("e.sent_at")} and coalesce(jsonb_array_length(p.test_result -> 'replies'), 0) = 0)::int as no_reply,
              count(*) filter (where e.status = 'sent' and ${inRange("e.sent_at")} and p.capture_score is not null)::int as scored
         from enquiries e join tenants t on t.tenant_id = e.tenant_id join prospects p on p.prospect_id = e.prospect_id
        where ($1::uuid is null or e.business_id = $1)
        group by e.purpose`,
      [input.businessId ?? null, input.from, input.to],
    );
    for (const row of enquiries.rows) {
      const { purpose, ...numbers } = row;
      stats.enquiries[purpose as "prospect" | "rival"] = numbers as EnquiryStats;
    }
    for (const row of counts.rows) {
      stats.stages[row.stage as (typeof STAGES)[number]] += row.n;
      if (row.stage === "filtered_out") stats.filtered_out_by_reason[row.reason] = row.n;
      if (row.stage === "found") stats.found_by_signal[row.reason] = row.n;
    }
    return stats;
  });
}

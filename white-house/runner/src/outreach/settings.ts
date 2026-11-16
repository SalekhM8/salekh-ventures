import { z } from "zod";
import { ControlError } from "../control/errors.js";

/**
 * The prospecting settings, held in versioned config (kind "setting", key
 * "outreach") so that only the UI's role, acting for an owner, can change
 * them. Anything missing takes the default below.
 */

export const SIGNALS = ["hiring_front_desk", "meta_ads", "weak_social", "poor_reviews"] as const;
export type Signal = (typeof SIGNALS)[number];

export const SIGNAL_MEANING: Record<Signal, string> = {
  hiring_front_desk: "advertising for a receptionist, front desk or admin role",
  meta_ads: "running Meta (Facebook or Instagram) adverts",
  weak_social: "social accounts that are dead or rarely posted to",
  poor_reviews: "poor reviews, or reviews left unanswered",
};

const count = z.number().int().min(0).max(100);

/** Words about a person's health. An enquiry that uses one is refused: it asks about a price or a time, never a problem. */
export const HEALTH_WORDS = [
  "pain", "ache", "aching", "toothache", "headache", "hurt", "sore", "symptom", "diagnos", "bleed", "swollen", "swelling", "infect", "abscess", "medical history",
  "medication", "pregnan", "allerg", "my condition", "my tooth", "my teeth", "my gums", "my skin", "my face", "my health", "suffer", "broken",
  "chipped", "emergency", "urgent", "anxious", "nervous", "diabet", "blood pressure", "surgery i had", "my doctor", "my dentist",
] as const;

/**
 * Large UK dental and aesthetics groups, each verified on its own website on 15 Nov 2026 as describing itself as a
 * group or network (PortmanDentex "dental group"; Rodericks "over 220 practices"; mydentist "over 500 UK dental
 * practices"; Colosseum Dental "80+ clinics"; Thérapie Clinic "more than 75 clinics"; Riverdale Healthcare "a group
 * of independent dental practices"). Others that could not be checked that day are NOT here: Salekh adds them.
 */
export const KNOWN_GROUPS = ["PortmanDentex", "Rodericks Dental Partners", "mydentist", "Colosseum Dental", "Thérapie Clinic", "Riverdale Healthcare"] as const;

/** A starting spread, for Salekh to edit. */
export const ENGLISH_PLACES = [
  "Birmingham", "Manchester", "Leeds", "Liverpool", "Sheffield", "Bristol", "Newcastle upon Tyne", "Nottingham", "Leicester", "London",
  "Coventry", "Bradford", "Southampton", "Portsmouth", "Plymouth", "Derby", "Stoke-on-Trent", "Wolverhampton", "Brighton", "Hull",
  "Reading", "Norwich", "Oxford", "Cambridge", "Milton Keynes", "Northampton", "Luton", "York", "Exeter", "Bournemouth",
  "Sunderland", "Preston", "Middlesbrough", "Ipswich", "Gloucester", "Cheltenham", "Bath", "Chester", "Lincoln", "Peterborough",
] as const;


// ---- the kinds of business looked for ------------------------------------------------

/**
 * THE ESTIMATED MONTHLY LEAK cannot be measured from outside, so it is an estimate and is always shown as one,
 * with its workings. Two inputs are real: the price the business publishes for its highest value service, and
 * the result of the test. The three here are SALEKH'S ASSUMPTIONS, as a low and a high value, for one kind of
 * business. Every figure seeded below is a cautious PLACEHOLDER put in by the build so the sum can be shown:
 * they come from no study and no benchmark. Edit them.
 */
const leakAssumptions = z
  .strictObject({
    /** Enquiries a month a business of this kind receives. */
    enquiries_a_month: z.strictObject({ low: z.number().min(0).default(20), high: z.number().min(0).default(60) }).prefault({}),
    /** The share of enquiries lost when the reply is slow or never comes. */
    share_lost_to_a_slow_reply: z.strictObject({ low: z.number().min(0).max(1).default(0.1), high: z.number().min(0).max(1).default(0.3) }).prefault({}),
    /** The share of enquiries that would have gone on to buy. */
    share_that_would_have_bought: z.strictObject({ low: z.number().min(0).max(1).default(0.1), high: z.number().min(0).max(1).default(0.25) }).prefault({}),
  })
  .prefault({});

const businessType = z.strictObject({
  /** Short and fixed: it is stored on every prospect of this kind. */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  /** The plain name, as it is written in prompts and on cards. */
  name: z.string().trim().min(1).max(200),
  /** Off: no new business of this kind is looked for. Those already on the list are still scored and carded. */
  enabled: z.boolean().default(true),
  /** What is searched for, with " in <place>" added. One Google Places call per phrase and place. */
  search_phrases: z.array(z.string().trim().min(2).max(100)).min(1).max(6),
  /** Groups and chains of this kind to leave out. EDITABLE. */
  excluded_groups: z.array(z.string().trim().min(2).max(100)).max(200).default([]),
  /** For the analysis: what counts as this kind of business's high value service. */
  high_value_guidance: z.string().trim().max(400).default(""),
  /** For the enquiry: what a genuine customer of this kind of business would ask. Always a price or availability question about one service. */
  enquiry_guidance: z.string().trim().max(600).default("Ask what their main service costs and when they could next speak to a new customer."),
  /** Words (or the start of a word) an enquiry to this kind of business must never contain. EDITABLE. */
  forbidden_topics: z.array(z.string().trim().min(2).max(40)).max(200).default([]),
  /** What is said back to the drafting model when one of them is found. */
  forbidden_reason: z.string().trim().max(300).default("it gives personal circumstances. Ask only about the price or availability of the service"),
  /** false: email is not a fair test of this kind of business, so none is sent and it is judged on fit alone. */
  email_test: z.boolean().default(true),
  /** A caution printed on every card of this kind. */
  card_note: z.string().trim().max(400).default(""),
  /** Who to ask for when no person is named. */
  ask_for: z.string().trim().max(100).default("the owner or the manager"),
  /** A word or two added to each front desk role when searching for job adverts. Empty: adverts are not searched for this kind. */
  job_search_hint: z.string().trim().max(60).default(""),
  leak_assumptions: leakAssumptions,
});
export type BusinessType = z.infer<typeof businessType>;

/** The id every prospect had before there was more than one kind. */
export const FIRST_TYPE_ID = "clinics";

/**
 * The kinds seeded by the build. Every leak assumption here is the same cautious PLACEHOLDER (see above): none
 * has been set for its trade. E-COMMERCE IS NOT HERE ON PURPOSE: a shop has no enquiry-to-booking path to test.
 */
const BUILT_IN_TYPES: Record<string, Record<string, unknown>> = {
  clinics: {
    name: "private dental and aesthetics clinics",
    search_phrases: ["private dental and aesthetics clinics"],
    excluded_groups: [...KNOWN_GROUPS],
    high_value_guidance: "The most expensive or most prominently sold treatment, for example dental implants, orthodontics or a named course of aesthetic treatment.",
    enquiry_guidance: "Ask the price of one named treatment and when a consultation or appointment for it is next available.",
    forbidden_topics: [...HEALTH_WORDS],
    forbidden_reason: "it describes a health problem or personal circumstances. Ask only about the price or availability of the treatment",
    ask_for: "the owner or the practice manager",
    job_search_hint: "dental clinic",
  },
  solicitors: {
    name: "solicitors for conveyancing and family law",
    search_phrases: ["conveyancing solicitors", "family law solicitors"],
    high_value_guidance: "The service with the largest fee the pages show, for example conveyancing on a sale and purchase, a divorce or a financial settlement.",
    enquiry_guidance: "Ask for a rough fee estimate for one service (for example conveyancing, or an initial family law consultation) and how soon someone could speak to a new client.",
    forbidden_topics: ["my divorce", "my ex", "my husband", "my wife", "my partner", "my children", "custody", "my case", "our case", "my dispute", "court", "being sued", "injunction", "abuse",
      "we are buying", "i am buying", "we are selling", "i am selling", "our purchase", "my purchase", "the property at", "instruct", "exchange date", "completion date"],
    forbidden_reason: "it describes a legal matter of its own or says it is instructing. Never invent a case: ask only for a fee estimate and how soon someone could speak to a new client",
    ask_for: "the senior partner or the practice manager",
  },
  "financial-advisers": {
    name: "independent financial advisers and mortgage brokers",
    search_phrases: ["independent financial adviser", "mortgage broker"],
    high_value_guidance: "The service the pages lead with, for example pension or investment advice, or arranging a mortgage. Fees are often a percentage: report a figure only if a page gives one in pounds.",
    enquiry_guidance: "Ask what an initial consultation costs and when one is next available.",
    forbidden_topics: ["my savings", "my pension", "my income", "my salary", "i earn", "we earn", "my mortgage", "my debt", "my deposit", "my credit", "i have saved", "inherit", "should i invest",
      "which fund", "what should i", "recommend", "best rate", "is it worth", "advise me", "what would you advise"],
    forbidden_reason: "it gives financial details or asks for advice. Ask only what an initial consultation costs and when one is available",
    ask_for: "the principal adviser or the practice manager",
  },
  "estate-agents": {
    name: "estate and letting agents",
    search_phrases: ["estate agents", "letting agents"],
    high_value_guidance: "Selling a property, or full management of a let. Fees are often a percentage: report a figure only if a page gives one in pounds.",
    enquiry_guidance: "Ask what their fees are for selling or for letting a property, and how soon a valuation could be done.",
    forbidden_topics: ["my house", "my flat", "my home", "our house", "our home", "my property", "the address", "i live", "we live", "my landlord", "my tenant", "bedroom", "my road", "my street"],
    forbidden_reason: "it describes a property or gives an address. Ask only about their fees and how soon a valuation could be done, and do not book one",
    ask_for: "the branch owner or the manager",
  },
  accountants: {
    name: "accountants for small businesses",
    search_phrases: ["accountants for small businesses"],
    high_value_guidance: "Year end accounts and tax for a limited company, or a monthly bookkeeping and payroll package.",
    enquiry_guidance: "Ask roughly what they charge for a limited company's year end accounts and when a first call is available.",
    forbidden_topics: ["my turnover", "our turnover", "my company is called", "our company is called", "my tax bill", "i owe", "we owe", "hmrc investigation", "my utr", "my profit", "our profit", "my accountant"],
    forbidden_reason: "it gives details of a business or its money. Ask only what they charge for a limited company's accounts and when a first call is available",
    ask_for: "the owner or a partner",
  },
  trades: {
    name: "home improvement trades doing large jobs: kitchens, bathrooms, roofing, driveways, solar",
    search_phrases: ["kitchen fitters", "bathroom fitters", "roofing contractors", "driveway installers", "solar panel installers"],
    high_value_guidance: "The largest kind of job the pages show, for example a fitted kitchen, a new roof, a driveway or a solar installation.",
    enquiry_guidance: "Ask roughly what a typical job of one kind costs and how soon a survey could be done.",
    forbidden_topics: ["my address", "the address", "i live", "we live", "my house", "our house", "my home", "my roof", "our roof", "my kitchen", "our kitchen", "my bathroom", "my drive", "leak", "emergency", "urgent", "asap"],
    forbidden_reason: "it describes a property, gives an address or makes it urgent. Ask only roughly what a typical job costs and how soon a survey could be done, and do not book one",
    // Salekh's own strategy file says trades answer email poorly: they live on the phone.
    card_note: "A trade. Trades tend to answer the phone and messages far more than email, so a poor result on an emailed test may under-report how well this business really captures enquiries. Weigh it accordingly.",
    ask_for: "the owner",
  },
};
export const BUILT_IN_TYPE_IDS = Object.keys(BUILT_IN_TYPES);

/**
 * Bring a stored value to the current shape. Three things are accepted:
 *   - nothing about types at all: the built-in kinds, all switched on;
 *   - the shape from before there was more than one kind (`business_type`, `excluded_groups` and so on at the
 *     top): that one kind becomes "clinics", keeping its name, its groups, its forbidden words and its
 *     assumptions, and stays the only one switched on. The others are added switched OFF, so a house that
 *     was looking for clinics goes on looking for clinics until someone switches another kind on;
 *   - a list of kinds, where an entry naming a built-in kind need only say what differs from it.
 */
const LEGACY = ["business_type", "excluded_groups", "enquiry_forbidden_words", "leak_assumptions", "job_search_hint"] as const;
export function toCurrentShape(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  const legacy = LEGACY.some((key) => key in out);
  const given = Array.isArray(out.business_types) ? (out.business_types as unknown[]) : null;
  let list: unknown[];
  if (given) {
    list = given.map((entry) => {
      const id = typeof (entry as { id?: unknown } | null)?.id === "string" ? ((entry as { id: string }).id) : "";
      return id in BUILT_IN_TYPES ? { ...BUILT_IN_TYPES[id], ...(entry as object) } : entry;
    });
  } else {
    list = BUILT_IN_TYPE_IDS.map((id) => ({ id, ...BUILT_IN_TYPES[id], ...(legacy && id !== FIRST_TYPE_ID ? { enabled: false } : {}) }));
  }
  if (legacy) {
    const first = list.find((t) => (t as { id?: unknown } | null)?.id === FIRST_TYPE_ID) as Record<string, unknown> | undefined;
    if (first) {
      if (typeof out.business_type === "string" && out.business_type.trim()) {
        const same = out.business_type.trim() === BUILT_IN_TYPES[FIRST_TYPE_ID]!.name;
        first.name = out.business_type.trim();
        if (!same) first.search_phrases = [out.business_type.trim()];
      }
      if (out.excluded_groups !== undefined) first.excluded_groups = out.excluded_groups;
      if (out.enquiry_forbidden_words !== undefined) first.forbidden_topics = out.enquiry_forbidden_words;
      if (out.leak_assumptions !== undefined) first.leak_assumptions = out.leak_assumptions;
      if (typeof out.job_search_hint === "string") first.job_search_hint = out.job_search_hint;
    }
    for (const key of LEGACY) delete out[key];
  }
  out.business_types = list;
  return out;
}

const shape = z.strictObject({
  /**
   * THE KINDS OF BUSINESS LOOKED FOR. A run takes the next few (kind, place) pairs, least recently searched
   * first, so every kind that is switched on gets its share of every place. Each prospect keeps its kind, and
   * its rivals, its enquiry, its leak estimate and its card are all by that kind. EDITABLE.
   */
  business_types: z.array(businessType).min(1).max(30).refine((list) => new Set(list.map((t) => t.id)).size === list.length, "two kinds have the same id"),
  /** The whole territory. It is too big for one search, so each run searches the next few of `areas`. */
  area: z.string().trim().min(1).max(200).default("England"),
  /**
   * The towns and cities to work through, a few each run, oldest searched first. EDITABLE: this is a
   * starting spread of English cities and large towns, not a considered list. Empty: search `area` itself.
   */
  areas: z.array(z.string().trim().min(1).max(100)).max(200).default([...ENGLISH_PLACES]),
  /** 8 since the first real run: most businesses found by kind and place had no signal, so more places are searched for adverts. */
  areas_per_run: z.number().int().min(1).max(20).default(8),
  /** A job advert older than this is not a signal. An advert that does not show its age still counts, and the card says so. */
  advert_max_age_days: z.number().int().min(1).max(3650).default(60),
  /** The most searches and page reads one run may make through the search tool. The rest of the run goes on without them. 300 since the tool rate limited a run of 274 followed by another. */
  max_fetches_per_run: z.number().int().min(10).max(5000).default(300),
  /** The most calls to Google Places in one run. Each is billed by Google; see connectors/places.ts for the tier. */
  max_places_calls_per_run: z.number().int().min(0).max(500).default(20),
  /** How far round a low scoring business its nearest rivals are looked for, in metres. */
  rival_search_radius_metres: z.number().int().min(100).max(50_000).default(5000),
  /** The least time between two calls to the search tool, so its own limits are not run into by haste. */
  min_seconds_between_fetches: z.number().min(0).max(60).default(1.5),
  /** A business showing this many premises or more is treated as a chain even when no group is named. Two or three sites is an owner, not a chain. */
  chain_locations: z.number().int().min(2).max(1000).default(10),
  /** How many businesses are looked at in one run. 50 is Salekh's choice (the brief's 100 comes once cost is measured). */
  find_per_run: z.number().int().min(1).max(200).default(50),
  shortlist_size: z.number().int().min(1).max(100).default(20),
  /**
   * Route one of the find stage starts from public job adverts for these front desk roles.
   * An advert is both how a business is found and the evidence for the signal.
   */
  front_desk_roles: z.array(z.string().trim().min(1).max(60)).min(1).max(12)
    .default(["receptionist", "front of house", "patient coordinator", "treatment coordinator", "practice administrator"]),
  /** Extra web searches to run, as written. */
  extra_searches: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  signals: z.array(z.enum(SIGNALS)).min(1).default([...SIGNALS]),

  // ---- the test enquiry by email, and the capture score ----
  /** Off: no enquiry is drafted, and the shortlist is made from fit and signals alone, as before. */
  test_enquiries: z.boolean().default(true),
  /** How an enquiry is signed. Salekh's own first name: no invented identity. */
  enquiry_signoff: z.string().trim().min(1).max(40).default("Salekh"),
  enquiry_max_chars: z.number().int().min(100).max(1500).default(600),
  /** The least time between two enquiries going out, so they do not leave in a burst. */
  enquiry_send_gap_seconds: z.number().min(0).max(3600).default(90),
  /** How long after sending before a business is scored. */
  reply_wait_hours: z.number().min(0).max(240).default(24),
  /** How long after sending the mailbox is still searched for that business's replies. */
  reply_window_days: z.number().int().min(1).max(30).default(3),
  /** At or below this capture score, with fit passing, a business is a prospect. Above it, it is kept as a comparison. */
  capture_threshold: count.default(50),
  /** A business whose estimate, at its high end, is below this many pounds a month is not shortlisted. Applied only when an estimate exists. */
  min_estimated_leak: z.number().min(0).max(10_000_000).default(5000),
  capture_weights: z
    .strictObject({
      // Reply speed by a person, the largest part.
      within_15_minutes: count.default(50),
      within_1_hour: count.default(42),
      within_4_hours: count.default(32),
      same_day: count.default(22),
      within_24_hours: count.default(12),
      // Reply quality.
      answered_the_question: count.default(12),
      offered_a_next_step: count.default(8),
      followed_up: count.default(10),
      // Enquiry routes offered.
      per_kind_of_route: count.default(4),
      route_kinds_counted: count.default(3),
      a_route_that_works_out_of_hours: count.default(8),
    })
    .prefault({}),
  filters: z
    .strictObject({
      exclude_groups: z.boolean().default(true),
      require_limited_company: z.boolean().default(true),
      /** The brief finds businesses by their signals. false lets one through with none. */
      require_signal: z.boolean().default(true),
      /** With no Companies House key nothing can be confirmed. true keeps such a business and flags it on its card. */
      allow_unchecked_limited_company: z.boolean().default(true),
      require_named_contact: z.boolean().default(true),
      require_money_signal: z.boolean().default(true),
      require_contact_route: z.boolean().default(true),
      /** "Several staff" in the brief, as a number. */
      several_staff: z.number().int().min(1).max(1000).default(3),
    })
    .prefault({}),
  score_weights: z
    .strictObject({
      signal: z.strictObject({ hiring_front_desk: count.default(25), meta_ads: count.default(15), weak_social: count.default(10), poor_reviews: count.default(10) }).prefault({}),
      signal_cap: count.default(45),
      high_value_service: count.default(10),
      runs_ads: count.default(10),
      staff_five_or_more: count.default(10),
      staff_several: count.default(5),
      two_or_more_locations: count.default(5),
      money_cap: count.default(30),
      named_contact: count.default(5),
      // Salekh does not email prospects: the routes he can use by hand (a direct message, a call) weigh most.
      route: z.strictObject({ whatsapp: count.default(4), instagram: count.default(3), phone: count.default(3), facebook: count.default(2), form: count.default(1), email: count.default(1), booking: count.default(1), other: count.default(0) }).prefault({}),
      route_cap: count.default(10),
      limited_company_confirmed: count.default(10),
    })
    .prefault({}),
  /**
   * Which agent a message leads with, by signal, strongest first. The first
   * three are the strategy's table. poor_reviews is not in that table: it is
   * set to Enquiries as a placeholder until Salekh says.
   */
  lead_agent_by_signal: z
    .strictObject({
      hiring_front_desk: z.string().min(1).default("Enquiries"),
      meta_ads: z.string().min(1).default("Ads with data"),
      weak_social: z.string().min(1).default("Content"),
      poor_reviews: z.string().min(1).default("Enquiries"),
    })
    .prefault({}),
});

type Stored = z.infer<typeof shape>;

/**
 * The settings as code uses them: what is stored, plus the fields of ONE kind of business set out at the top
 * (`business_type`, `excluded_groups` and so on), so that code dealing with one business reads its kind's
 * rules without knowing there are several. `parseOutreachSettings` sets them from the first kind switched on;
 * `forType` gives the same settings for any other kind.
 */
export type OutreachSettings = Stored & {
  type: BusinessType;
  business_type: string;
  excluded_groups: string[];
  enquiry_forbidden_words: string[];
  leak_assumptions: BusinessType["leak_assumptions"];
  job_search_hint: string;
};

function withType(stored: Stored, type: BusinessType): OutreachSettings {
  return { ...stored, type, business_type: type.name, excluded_groups: type.excluded_groups, enquiry_forbidden_words: type.forbidden_topics, leak_assumptions: type.leak_assumptions, job_search_hint: type.job_search_hint };
}

/** The same settings, seen for one kind of business. An id that is no longer in the list (a kind since removed) falls back to the first. */
export function forType(settings: OutreachSettings, typeId: string | null | undefined): OutreachSettings {
  if (settings.type.id === typeId) return settings;
  const type = settings.business_types.find((t) => t.id === typeId) ?? settings.business_types.find((t) => t.id === FIRST_TYPE_ID) ?? (settings.business_types[0] as BusinessType);
  return withType(settings, type);
}

/** The kinds switched on, in their listed order. */
export const enabledTypes = (settings: OutreachSettings): BusinessType[] => settings.business_types.filter((t) => t.enabled);

/** What is written to config: the current shape, with nothing derived in it. */
export function toStoredForm(settings: OutreachSettings): Record<string, unknown> {
  const { type: _type, business_type: _a, excluded_groups: _b, enquiry_forbidden_words: _c, leak_assumptions: _d, job_search_hint: _e, ...stored } = settings;
  return stored;
}

export function parseOutreachSettings(value: unknown): OutreachSettings {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const parsed = shape.safeParse(isObject ? toCurrentShape(value as Record<string, unknown>) : undefined);
  if (!parsed.success || !isObject) {
    const where = parsed.success ? "not an object" : parsed.error.issues.map((i) => i.path.join(".") || "settings").join(", ");
    throw new ControlError("bad_settings", `the outreach settings are not valid: ${where}`);
  }
  const first = parsed.data.business_types.find((t) => t.enabled) ?? (parsed.data.business_types[0] as BusinessType);
  return withType(parsed.data, first);
}

export const DEFAULT_OUTREACH_SETTINGS: OutreachSettings = parseOutreachSettings({});

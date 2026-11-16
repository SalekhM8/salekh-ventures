import { companyNumberKey, nameKey, postcodeKey } from "../../outreach/normalise.js";
import { ControlError } from "../errors.js";

/**
 * A read only connector to the Companies House public data API, used by
 * plain code to answer one question: is this business a limited company,
 * and who are its directors on the public register?
 *
 * From the official documentation (checked 15 Nov 2026):
 *   base      https://api.company-information.service.gov.uk
 *   auth      HTTP basic, the API key as the user name and a blank password
 *   profile   GET /company/{company_number}
 *   officers  GET /company/{company_number}/officers
 *   search    GET /search/companies?q=...&items_per_page=...
 *
 * The key is read by the runner and never reaches an agent. With no key
 * there is no connector, and a prospect's status is "not checked".
 */

export interface CompanyLookup {
  /** As printed by the business, if it printed one. */
  number?: string | null;
  name: string;
  postcode?: string | null;
}

export interface CompanyResult {
  /** yes: an active limited company. no: registered, but not a limited company. not_found: no confident match. */
  status: "yes" | "no" | "not_found";
  company?: { name: string; number: string; status: string; type: string; postcode: string | null; matched_by: "number" | "name"; source_url: string };
  /** Active directors (or LLP members) who are people, as "Forename Surname". Public register data. */
  directors?: string[];
}

export interface CompaniesHouseConnector {
  lookup(query: CompanyLookup): Promise<CompanyResult>;
}

const BASE = "https://api.company-information.service.gov.uk";
const PUBLIC_PAGE = "https://find-and-update.company-information.service.gov.uk/company/";
/** Company types that are corporate bodies with limited liability. */
const LIMITED_TYPES = new Set([
  "ltd", "plc", "llp", "private-limited-guarant-nsc", "private-limited-guarant-nsc-limited-exemption",
  "private-limited-shares-section-30-exemption", "community-interest-company",
]);
const PERSON_ROLES = new Set(["director", "llp-member", "llp-designated-member"]);

/** "SURNAME, Forename Other" as the register writes it, to "Forename Other Surname". */
function readableName(registerName: string): string {
  const title = (text: string) => text.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, lead: string, letter: string) => lead + letter.toUpperCase());
  const [surname, forenames] = registerName.split(",").map((part) => part.trim());
  return forenames ? `${title(forenames)} ${title(surname as string)}` : title(surname as string);
}

export function createCompaniesHouseConnector(options: { apiKey: string; fetch?: typeof fetch }): CompaniesHouseConnector {
  if (!options.apiKey) throw new Error("Companies House connector: no API key");
  const doFetch = options.fetch ?? fetch;
  const headers = { Authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`, Accept: "application/json" };

  async function get(pathAndQuery: string): Promise<any | null> {
    const response = await doFetch(`${BASE}${pathAndQuery}`, { method: "GET", headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new ControlError(`companies_house_http_${response.status}`, `Companies House answered ${response.status}`);
    return response.json();
  }

  async function directorsOf(number: string): Promise<string[]> {
    const list = await get(`/company/${number}/officers?items_per_page=35`);
    const items: any[] = Array.isArray(list?.items) ? list.items : [];
    return items
      .filter((o) => PERSON_ROLES.has(o?.officer_role) && !o?.resigned_on && typeof o?.name === "string")
      .map((o) => readableName(o.name));
  }

  async function finish(raw: { name: string; number: string; status: string; type: string; postcode: string | null }, matchedBy: "number" | "name"): Promise<CompanyResult> {
    const company = { ...raw, matched_by: matchedBy, source_url: `${PUBLIC_PAGE}${raw.number}` };
    if (raw.status !== "active") return { status: "not_found" };
    if (!LIMITED_TYPES.has(raw.type)) return { status: "no", company };
    return { status: "yes", company, directors: await directorsOf(raw.number) };
  }

  return {
    async lookup(query: CompanyLookup): Promise<CompanyResult> {
      const number = companyNumberKey(query.number ?? null);
      const wanted = nameKey(query.name);
      if (!number && !wanted) throw new ControlError("invalid_request", "a company lookup needs a valid number or a name");

      if (number) {
        const profile = await get(`/company/${number}`);
        if (profile) {
          return finish(
            { name: String(profile.company_name ?? ""), number, status: String(profile.company_status ?? ""), type: String(profile.type ?? ""), postcode: profile.registered_office_address?.postal_code ?? null },
            "number",
          );
        }
      }
      if (!wanted) return { status: "not_found" };

      // By name: only an exact match (legal endings aside) that is active and limited, and only when there is one.
      const search = await get(`/search/companies?q=${encodeURIComponent(query.name.trim())}&items_per_page=20`);
      const items: any[] = Array.isArray(search?.items) ? search.items : [];
      let exact = items.filter((i) => nameKey(i?.title) === wanted && i?.company_status === "active" && LIMITED_TYPES.has(i?.company_type));
      const postcode = postcodeKey(query.postcode ?? null);
      if (exact.length > 1 && postcode) exact = exact.filter((i) => postcodeKey(i?.address?.postal_code) === postcode);
      if (exact.length !== 1) return { status: "not_found" };
      const hit = exact[0];
      const hitNumber = companyNumberKey(hit.company_number);
      if (!hitNumber) return { status: "not_found" };
      return finish({ name: String(hit.title), number: hitNumber, status: "active", type: String(hit.company_type), postcode: hit.address?.postal_code ?? null }, "name");
    },
  };
}

/** No key, no connector: the pipeline then records "not checked" and carries on. */
export function companiesHouseFromKey(apiKey: string | undefined, fetchImpl?: typeof fetch): CompaniesHouseConnector | null {
  return apiKey ? createCompaniesHouseConnector({ apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) }) : null;
}

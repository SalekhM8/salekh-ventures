import { ControlError } from "../errors.js";

/**
 * Google Places API (New), by plain code. One call is used: Text Search.
 *
 * THE FIELD MASK DECIDES THE PRICE. Google bills a call at the tier of the
 * dearest field asked for, so the masks live here, in one place, and list
 * only what the pipeline uses. Checked against Google's "Place data fields"
 * table on 16 Nov 2026:
 *
 *   id                                              Essentials (IDs only)
 *   displayName, formattedAddress, postalAddress,
 *   location, businessStatus                        Pro
 *   websiteUri, nationalPhoneNumber, rating,
 *   userRatingCount, regularOpeningHours            Enterprise
 *
 * So every call made here is billed as "Text Search Enterprise". `reviews`
 * is NOT asked for: it would move the call to "Enterprise + Atmosphere", and
 * the Review object carries no owner reply, so it could not say whether a
 * business answers its reviews anyway. Place Details is not called at all.
 *
 * The key travels in a header to places.googleapis.com and nowhere else.
 */
export const PLACES_FIELD_MASKS = {
  /** Text Search: finding businesses in a place, and the nearest of the same kind to one business. */
  search: [
    "places.id", "places.displayName", "places.formattedAddress", "places.postalAddress", "places.location", "places.businessStatus",
    "places.websiteUri", "places.nationalPhoneNumber", "places.rating", "places.userRatingCount", "places.regularOpeningHours.periods",
    "places.regularOpeningHours.weekdayDescriptions", "nextPageToken",
  ].join(","),
} as const;

export const PLACES_PRICE_TIERS = { search: "Text Search Enterprise" } as const;

export interface OpeningPeriod {
  /** 0 is Sunday. Minutes are from midnight. close null: open round the clock. */
  open: { day: number; minutes: number };
  close: { day: number; minutes: number } | null;
}

export interface Place {
  id: string;
  name: string;
  address: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  location: { lat: number; lng: number } | null;
  openingHours: { weekday: string[]; periods: OpeningPeriod[] } | null;
  /** false when Google marks it closed, temporarily or for good. */
  operational: boolean;
  /** A public Google Maps address for this place: the source given for every fact above. */
  sourceUrl: string;
}

export interface PlacesSearch {
  query: string;
  /** 1 to 20. */
  pageSize?: number;
  pageToken?: string;
  /** Nearest first, around a point. */
  near?: { lat: number; lng: number; radiusMetres: number };
}

export interface PlacesConnector {
  searchText(search: PlacesSearch): Promise<{ places: Place[]; nextPageToken: string | null }>;
}

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})\b/i;

export const placeSourceUrl = (id: string): string => `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(id)}`;

/** One place from the API's JSON. Anything missing or of the wrong shape is null, never guessed. */
export function toPlace(raw: any): Place | null {
  const id = typeof raw?.id === "string" ? raw.id : null;
  const name = typeof raw?.displayName?.text === "string" ? raw.displayName.text.trim() : "";
  if (!id || !name) return null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const address = text(raw.formattedAddress);
  const point = (p: any) => (Number.isInteger(p?.day) && Number.isInteger(p?.hour) ? { day: p.day as number, minutes: (p.hour as number) * 60 + (Number.isInteger(p.minute) ? (p.minute as number) : 0) } : null);
  const periods: OpeningPeriod[] = [];
  for (const p of Array.isArray(raw.regularOpeningHours?.periods) ? raw.regularOpeningHours.periods : []) {
    const open = point(p?.open);
    if (open) periods.push({ open, close: point(p?.close) });
  }
  const weekday = (Array.isArray(raw.regularOpeningHours?.weekdayDescriptions) ? raw.regularOpeningHours.weekdayDescriptions : []).filter((d: unknown) => typeof d === "string").slice(0, 7);
  return {
    id, name, address,
    postcode: text(raw.postalAddress?.postalCode) ?? address?.match(UK_POSTCODE)?.[1]?.toUpperCase() ?? null,
    phone: text(raw.nationalPhoneNumber), website: text(raw.websiteUri),
    rating: num(raw.rating), reviewCount: num(raw.userRatingCount),
    location: num(raw.location?.latitude) !== null && num(raw.location?.longitude) !== null ? { lat: raw.location.latitude, lng: raw.location.longitude } : null,
    openingHours: periods.length > 0 || weekday.length > 0 ? { weekday, periods } : null,
    operational: raw.businessStatus === undefined || raw.businessStatus === "OPERATIONAL",
    sourceUrl: placeSourceUrl(id),
  };
}

export function createPlacesConnector(options: { apiKey: string; fetch?: typeof fetch; regionCode?: string }): PlacesConnector {
  const doFetch = options.fetch ?? fetch;
  return {
    async searchText(search) {
      const body: Record<string, unknown> = {
        textQuery: search.query, regionCode: options.regionCode ?? "GB", languageCode: "en-GB",
        pageSize: Math.min(20, Math.max(1, Math.floor(search.pageSize ?? 20))),
        ...(search.pageToken ? { pageToken: search.pageToken } : {}),
        ...(search.near
          ? { rankPreference: "DISTANCE", locationBias: { circle: { center: { latitude: search.near.lat, longitude: search.near.lng }, radius: Math.min(50_000, Math.max(1, search.near.radiusMetres)) } } }
          : {}),
      };
      let res: Response;
      try {
        res = await doFetch("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey, "x-goog-fieldmask": PLACES_FIELD_MASKS.search },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new ControlError("places_unreachable", "Google Places could not be reached");
      }
      // A fixed code only: the API's own error text is not passed on.
      if (res.status === 429) throw new ControlError("places_rate_limited", "Google Places reported a rate or quota limit");
      if (!res.ok) throw new ControlError("places_failed", `Google Places answered ${res.status}`);
      const json = (await res.json().catch(() => null)) as any;
      const places = (Array.isArray(json?.places) ? json.places : []).map(toPlace).filter((p: Place | null): p is Place => p !== null);
      return { places, nextPageToken: typeof json?.nextPageToken === "string" && json.nextPageToken ? json.nextPageToken : null };
    },
  };
}

/** null when no key is set: the pipeline then finds businesses by web search, as before. */
export function placesFromKey(key: string | undefined): PlacesConnector | null {
  return key && key.trim() ? createPlacesConnector({ apiKey: key.trim() }) : null;
}

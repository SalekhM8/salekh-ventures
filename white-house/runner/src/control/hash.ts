import { createHash } from "node:crypto";

/**
 * JSON with object keys in sorted order at every level, so the same payload
 * always gives the same text whatever order its keys arrive in. Postgres
 * jsonb does not keep key order, so a plain JSON.stringify would not do.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("payload holds a value that is not JSON");
    return text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

/** sha256 of the canonical JSON, in hex. This is "the hash of the payload". */
export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

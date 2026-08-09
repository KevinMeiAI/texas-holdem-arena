export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function encode(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON accepts only arrays and plain objects");
    }
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).sort().map((key) => {
      const item = object[key];
      if (item === undefined) throw new Error("Canonical JSON rejects undefined object values");
      return `${JSON.stringify(key)}:${encode(item)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return encode(value);
}

import { z } from "zod";

/** LLMs (e.g. via OpenRouter) often emit Python-style `"True"` / `"False"` strings. */
export const coerceModelBoolean = (val: unknown, defaultValue: boolean): boolean => {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "number") {
    return val !== 0;
  }
  if (typeof val === "string") {
    const t = val.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") {
      return true;
    }
    if (t === "false" || t === "0" || t === "no" || t === "null" || t === "") {
      return false;
    }
  }
  return defaultValue;
};

export const zModelBoolean = (defaultValue: boolean) =>
  z.preprocess(
    (val) => coerceModelBoolean(val, defaultValue),
    z.boolean().default(defaultValue),
  );

export const zModelOptionalBoolean = (defaultValue: boolean) =>
  z.preprocess(
    (val) => coerceModelBoolean(val, defaultValue),
    z.boolean().optional().default(defaultValue),
  );

/** Treat literal `"null"` / empty string as omitted optional fields. */
export const zModelOptionalString = z.preprocess((val) => {
  if (val === null || val === undefined) {
    return undefined;
  }
  if (typeof val === "string") {
    const t = val.trim();
    if (!t.length || t.toLowerCase() === "null") {
      return undefined;
    }
  }
  return val;
}, z.string().optional());

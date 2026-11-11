// Typed reads from JSON the hub doesn't control: the layout file, request
// bodies and Govee's responses. A field that is absent or null reads as null;
// one of the wrong type is an error naming the field.

/** A value didn't have the expected shape. */
export class JsonShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonShapeError";
  }
}

/** Parses text, reporting malformed JSON as a JsonShapeError. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new JsonShapeError(err instanceof Error ? err.message : String(err));
  }
}

export function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads the fields of one JSON object. where names it in error messages. */
export class Fields {
  readonly #obj: Readonly<Record<string, unknown>>;
  readonly #where: string;

  constructor(v: unknown, where: string) {
    if (!isObject(v)) {
      throw new JsonShapeError(`${where} must be an object`);
    }
    this.#obj = v;
    this.#where = where;
  }

  /**
   * Rejects fields other than allowed, so a typo like "brightnes" fails loudly
   * instead of doing nothing.
   */
  only(...allowed: string[]): this {
    for (const key of Object.keys(this.#obj)) {
      if (!allowed.includes(key)) {
        throw new JsonShapeError(`unknown field ${JSON.stringify(key)}`);
      }
    }
    return this;
  }

  required(...keys: string[]): this {
    for (const key of keys)
      if (!Object.hasOwn(this.#obj, key)) throw new JsonShapeError(`missing field ${JSON.stringify(key)}`);
    return this;
  }

  string(key: string): string | null {
    return this.#read(key, "a string", (v): v is string => typeof v === "string");
  }

  bool(key: string): boolean | null {
    return this.#read(key, "true or false", (v): v is boolean => typeof v === "boolean");
  }

  /** A whole number. */
  int(key: string): number | null {
    return this.#read(key, "a whole number", (v): v is number => Number.isSafeInteger(v));
  }

  number(key: string): number | null {
    return this.#read(key, "a number", (v): v is number => typeof v === "number");
  }

  /** A list; absent reads as empty. */
  list(key: string): readonly unknown[] {
    return this.#read(key, "a list", (v): v is unknown[] => Array.isArray(v)) ?? [];
  }

  /** The raw value, for nested objects. */
  value(key: string): unknown {
    return this.#obj[key] ?? null;
  }

  #read<T>(key: string, what: string, ok: (v: unknown) => v is T): T | null {
    const v = this.#obj[key];
    if (v === undefined || v === null) {
      return null;
    }
    if (!ok(v)) {
      throw new JsonShapeError(`${this.#where} ${key} must be ${what}`);
    }
    return v;
  }
}

// Environment files as the deployment reads them: KEY=value entries among
// comments and blank lines. Parsing and serializing keep every line as
// written, so an edit changes only the entries it names.

/** The keys the Secrets page can write. */
export const keyPattern = /^[A-Z][A-Z0-9_]*$/;

/** The key whose length the deployment checks before it starts the hub. */
export const hubPasswordKey = "HUB_PASSWORD";

const entryPattern = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** One line: a KEY=value entry, or any other line, kept as written. */
export type EnvLine = { kind: "entry"; key: string; value: string } | { kind: "other"; text: string };

export interface EnvFile {
  lines: EnvLine[];
  trailingNewline: boolean;
}

/** Sets a key, adding it at the end when absent, or deletes every entry of it. */
export type EnvChange = { key: string; value: string } | { key: string; delete: true };

/** A change the rules refuse. Messages name keys, never values. */
export class EnvError extends Error {}

export function parseEnv(text: string): EnvFile {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  if (text === "") return { lines: [], trailingNewline: false };
  return {
    lines: body.split("\n").map((line): EnvLine => {
      const match = entryPattern.exec(line);
      return match ? { kind: "entry", key: match[1] ?? "", value: match[2] ?? "" } : { kind: "other", text: line };
    }),
    trailingNewline,
  };
}

export function serializeEnv(file: EnvFile): string {
  const text = file.lines.map((line) => (line.kind === "entry" ? `${line.key}=${line.value}` : line.text)).join("\n");
  return file.trailingNewline ? text + "\n" : text;
}

/** Each key once, in the order it first appears. */
export function envKeys(file: EnvFile): string[] {
  return [...new Set(file.lines.flatMap((line) => (line.kind === "entry" ? [line.key] : [])))];
}

/** A key's value as written, from its last entry, which is the one that takes effect; null when absent. */
export function envValue(file: EnvFile, key: string): string | null {
  let value: string | null = null;
  for (const line of file.lines) if (line.kind === "entry" && line.key === key) value = line.value;
  return value;
}

/** The value a reader of the file sees: surrounding whitespace and quotes removed. */
export function effectiveValue(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}

/**
 * Applies changes in order and returns the new file. Keys must match
 * keyPattern, values may not contain line breaks, a deleted key must exist,
 * and HUB_PASSWORD must keep at least hubPasswordMinLength characters.
 */
export function applyEnvChanges(file: EnvFile, changes: readonly EnvChange[], hubPasswordMinLength: number): EnvFile {
  if (changes.length === 0) throw new EnvError("no changes to save");
  const seen = new Set<string>();
  let lines = [...file.lines];
  let trailingNewline = file.trailingNewline;
  for (const change of changes) {
    if (!keyPattern.test(change.key)) throw new EnvError(`invalid key ${JSON.stringify(change.key)}`);
    if (seen.has(change.key)) throw new EnvError(`${change.key} is changed more than once`);
    seen.add(change.key);
    const present = lines.some((line) => line.kind === "entry" && line.key === change.key);
    if ("delete" in change) {
      if (change.key === hubPasswordKey) throw new EnvError(`${hubPasswordKey} can't be deleted`);
      if (!present) throw new EnvError(`${change.key} is not in the file`);
      lines = lines.filter((line) => !(line.kind === "entry" && line.key === change.key));
      continue;
    }
    if (/[\r\n]/.test(change.value)) throw new EnvError(`${change.key}: values may not contain line breaks`);
    if (change.key === hubPasswordKey && effectiveValue(change.value).length < hubPasswordMinLength) {
      throw new EnvError(`${hubPasswordKey} must have at least ${hubPasswordMinLength} characters`);
    }
    if (present) {
      lines = lines.map((line) =>
        line.kind === "entry" && line.key === change.key ? { ...line, value: change.value } : line,
      );
    } else {
      lines.push({ kind: "entry", key: change.key, value: change.value });
      trailingNewline = true;
    }
  }
  return { lines, trailingNewline };
}

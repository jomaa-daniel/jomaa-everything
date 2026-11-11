// A small structured logger: one "level=INFO msg=... key=value" line per entry
// on stderr, which systemd's journal keeps.

export type Attrs = Record<string, unknown>;

export interface Log {
  info(msg: string, attrs: Attrs): void;
  warn(msg: string, attrs: Attrs): void;
  error(msg: string, attrs: Attrs): void;
  with(attrs: Attrs): Log;
}

function format(v: unknown): string {
  const s =
    v instanceof Error
      ? v.message
      : typeof v === "string"
        ? v
        : JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
  return /^[^\s"=]+$/.test(s) ? s : JSON.stringify(s);
}

/** A logger that writes lines with base attached to each. */
export function newLog(base: Attrs, write: (line: string) => void): Log {
  const emit = (level: string, msg: string, attrs: Attrs) => {
    const fields = Object.entries({ ...base, ...attrs }).map(([k, v]) => `${k}=${format(v)}`);
    write([`time=${new Date().toISOString()}`, `level=${level}`, `msg=${format(msg)}`, ...fields].join(" "));
  };
  return {
    info: (msg, attrs) => {
      emit("INFO", msg, attrs);
    },
    warn: (msg, attrs) => {
      emit("WARN", msg, attrs);
    },
    error: (msg, attrs) => {
      emit("ERROR", msg, attrs);
    },
    with: (attrs) => newLog({ ...base, ...attrs }, write),
  };
}

/** Logs to stderr. */
export const stderrLog: Log = newLog({}, (line) => process.stderr.write(line + "\n"));

/** A logger that drops everything, for tests. */
export const silentLog: Log = newLog({}, () => undefined);

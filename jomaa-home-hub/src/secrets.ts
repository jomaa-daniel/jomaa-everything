// The environment files the owner edits on the Secrets page. Only the listed
// files are read or written. A file in the release is a symlink to the real
// file in the checkout; saving replaces the real file and keeps the link.
import { randomBytes } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  applyEnvChanges,
  effectiveValue,
  EnvError,
  envKeys,
  envValue,
  keyPattern,
  parseEnv,
  serializeEnv,
  type EnvChange,
  type EnvFile,
} from "./envfile.js";

/** The variable in the token file that authorizes redeploys. */
export const tokenKey = "GITHUB_DEPLOY_TOKEN";

/** Shown in place of every value that is set. */
export const mask = "••••••••";

/** A request the Secrets page refuses, with its HTTP status. Messages never contain values. */
export class SecretsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface KeySummary {
  key: string;
  masked: string;
  hasValue: boolean;
}

export interface FileSummary {
  file: string;
  exists: boolean;
  keys: KeySummary[];
}

function missing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

export class EnvFiles {
  #saving: Promise<void> = Promise.resolve();

  /** files and tokenFile are paths relative to root; tokenFile is one of files. */
  constructor(
    private readonly root: string,
    readonly files: readonly string[],
    private readonly tokenFile: string,
    private readonly hubPasswordMinLength: number,
  ) {}

  /** Every listed file with its keys in file order and masked values. */
  async list(): Promise<FileSummary[]> {
    return Promise.all(
      this.files.map(async (file) => {
        const env = await this.#read(file);
        if (env === null) return { file, exists: false, keys: [] };
        const keys = envKeys(env).map((key) => {
          const hasValue = (envValue(env, key) ?? "") !== "";
          return { key, masked: hasValue ? mask : "", hasValue };
        });
        return { file, exists: true, keys };
      }),
    );
  }

  /** A key's value as written in the file. */
  async reveal(file: string, key: string): Promise<string> {
    if (!keyPattern.test(key)) throw new SecretsError(400, "invalid key");
    const env = await this.#existing(file);
    const value = envValue(env, key);
    if (value === null) throw new SecretsError(404, `${key} is not in ${file}`);
    return value;
  }

  /** Applies changes to a listed file. Saves run one at a time. */
  async save(file: string, changes: readonly EnvChange[]): Promise<void> {
    this.#path(file);
    const saved = this.#saving.then(async () => {
      let next: EnvFile;
      try {
        next = applyEnvChanges(await this.#existing(file), changes, this.hubPasswordMinLength);
      } catch (err) {
        if (err instanceof EnvError) throw new SecretsError(400, err.message);
        throw err;
      }
      await this.#write(file, serializeEnv(next));
    });
    this.#saving = saved.catch(() => undefined);
    await saved;
  }

  /** The redeploy token from the token file, or null when it isn't set. */
  async token(): Promise<string | null> {
    const env = await this.#read(this.tokenFile);
    const token = effectiveValue((env && envValue(env, tokenKey)) ?? "");
    return token === "" ? null : token;
  }

  #path(file: string): string {
    if (!this.files.includes(file)) throw new SecretsError(400, "that file is not one of the editable files");
    return join(this.root, file);
  }

  async #read(file: string): Promise<EnvFile | null> {
    const path = this.#path(file);
    try {
      return parseEnv(await readFile(path, "utf8"));
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  }

  async #existing(file: string): Promise<EnvFile> {
    const env = await this.#read(file);
    if (env === null) throw new SecretsError(404, `${file} does not exist`);
    return env;
  }

  /** Writes a temporary file beside the link's target with the target's mode, then renames it over the target. */
  async #write(file: string, text: string): Promise<void> {
    let target: string;
    try {
      target = await realpath(this.#path(file));
    } catch (err) {
      if (missing(err)) throw new SecretsError(404, `${file} does not exist`);
      throw err;
    }
    const mode = (await stat(target)).mode & 0o7777;
    const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const handle = await open(temp, "wx", mode);
      try {
        await handle.chmod(mode);
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}

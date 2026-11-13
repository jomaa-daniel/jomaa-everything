// Reruns the deployment workflow on GitHub and reads the run's status, with
// the token of the GitHub CLI login on the hub server.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { Fields, isObject, JsonShapeError, parseJson } from "./json.js";
import { SecretsError } from "./secrets.js";

/** The branch the receiver deploys from. */
export const deployBranch = "main";

export interface WorkflowRun {
  id: number;
  url: string;
  attempt: number;
  status: string;
  conclusion: string | null;
}

export interface WorkflowOptions {
  /** GitHub API base URL. */
  api: string;
  /** OWNER/REPOSITORY. */
  repo: string;
  /** Repository path of the workflow file. */
  workflow: string;
  timeoutMs: number;
}

/** Reads GitHub's answer; a shape the hub doesn't expect is GitHub's failure, not the client's. */
function fromGitHub<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof JsonShapeError) throw new SecretsError(502, `GitHub sent an unexpected answer: ${err.message}`);
    throw err;
  }
}

function parseRun(value: unknown): WorkflowRun {
  return fromGitHub(() => {
    const run = new Fields(value, "workflow run").required("id", "html_url", "run_attempt", "status");
    const id = run.int("id");
    const attempt = run.int("run_attempt");
    if (id === null || attempt === null) throw new JsonShapeError("workflow run must have an id and an attempt");
    return {
      id,
      url: run.string("html_url") ?? "",
      attempt,
      status: run.string("status") ?? "",
      conclusion: run.string("conclusion"),
    };
  });
}

/** The GitHub CLI's token, or why there is none. Reasons never contain the token. */
export type CliToken = { token: string } | { unavailable: string };

const execFileAsync = promisify(execFile);

/** The arguments that make the GitHub CLI print its login's token. */
const tokenArgs = ["auth", "token"];

/** Reads the token of the GitHub CLI login by running `<command> auth token`, without a shell. */
export class GitHubCli {
  constructor(
    private readonly command: string,
    private readonly timeoutMs: number,
  ) {}

  async token(): Promise<CliToken> {
    const invocation = `${this.command} ${tokenArgs.join(" ")}`;
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.command, tokenArgs, { timeout: this.timeoutMs, encoding: "utf8" }));
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : null;
      const killed = err instanceof Error && "killed" in err && err.killed === true;
      if (code === "ENOENT") return { unavailable: `the GitHub CLI is not installed at ${this.command}` };
      if (killed) return { unavailable: `${invocation} did not finish within ${this.timeoutMs / 1000} seconds` };
      if (typeof code === "number") return { unavailable: `${invocation} failed with exit code ${code}` };
      return { unavailable: `${invocation} could not run${typeof code === "string" ? ` (${code})` : ""}` };
    }
    const token = stdout.trim();
    return token === "" ? { unavailable: `${invocation} printed no token` } : { token };
  }
}

export class DeployWorkflow {
  constructor(private readonly options: WorkflowOptions) {}

  /** Reruns the latest push run of the workflow on the deploy branch; returns it as the new attempt, queued. */
  async rerunLatest(token: string): Promise<WorkflowRun> {
    const workflow = encodeURIComponent(basename(this.options.workflow));
    const query = new URLSearchParams({ branch: deployBranch, event: "push", per_page: "1" });
    const answer = await this.#request(token, "GET", `/actions/workflows/${workflow}/runs?${query.toString()}`);
    const latest = fromGitHub(() => new Fields(answer, "workflow runs").list("workflow_runs")[0]);
    if (latest === undefined) throw new SecretsError(404, `no push run of the deploy workflow on ${deployBranch} yet`);
    const run = parseRun(latest);
    await this.#request(token, "POST", `/actions/runs/${run.id}/rerun`);
    return { ...run, attempt: run.attempt + 1, status: "queued", conclusion: null };
  }

  async run(token: string, id: number): Promise<WorkflowRun> {
    return parseRun(await this.#request(token, "GET", `/actions/runs/${id}`));
  }

  async #request(token: string, method: string, path: string): Promise<unknown> {
    const [owner = "", name = ""] = this.options.repo.split("/");
    const url = `${this.options.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`;
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new SecretsError(504, "GitHub did not answer");
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = parseJson(text);
        if (isObject(body) && typeof body["message"] === "string") detail = `: ${body["message"]}`;
      } catch {
        // The status alone describes the failure.
      }
      throw new SecretsError(502, `GitHub answered HTTP ${response.status}${detail}`);
    }
    return text === "" ? null : fromGitHub(() => parseJson(text));
  }
}

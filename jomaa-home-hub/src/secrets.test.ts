import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Accounts } from "./accounts.js";
import { Api } from "./api.js";
import { Hub } from "./hub.js";
import { Fields, parseJson } from "./json.js";
import { silentLog } from "./log.js";
import { MatterNotReadyError, type MatterAdmin } from "./matter/nodes.js";
import { DeployWorkflow } from "./redeploy.js";
import { EnvFiles, mask, SecretsError, tokenKey } from "./secrets.js";
import { deploySettings, settings } from "./settings.js";
import { serve } from "./testing.js";

const ownerPassword = "owner password for the secrets test";
const hubSecret = "hub-secret-value-1234567890";
const tailnetSecret = "tskey-api-secret-value";
const deployToken = "fine_grained_fixture_token";
const files = ["app/.env", "net/.env"];

/** A release whose env files link to 0600 files in a separate checkout, as deployment lays them out. */
function release(token: string | null = null): { root: string; checkout: string } {
  const base = mkdtempSync(join(tmpdir(), "hub-secrets-"));
  const root = join(base, "release");
  const checkout = join(base, "checkout");
  const contents: Record<string, string> = {
    "app/.env": [
      "# The hub's secrets.",
      `HUB_PASSWORD=${ownerPassword}`,
      `HUB_SECRET=${hubSecret}`,
      "EMPTY=",
      ...(token === null ? [] : [`${tokenKey}=${token}`]),
      "",
    ].join("\n"),
    "net/.env": `TAILSCALE_API_KEY=${tailnetSecret}\n`,
  };
  for (const file of files) {
    const dir = file.split("/")[0] ?? "";
    mkdirSync(join(root, dir), { recursive: true });
    mkdirSync(join(checkout, dir), { recursive: true });
    writeFileSync(join(checkout, file), contents[file] ?? "");
    chmodSync(join(checkout, file), 0o600);
    symlinkSync(join(checkout, file), join(root, file));
  }
  writeFileSync(join(checkout, "unlisted.env"), "OTHER=not-editable\n");
  symlinkSync(join(checkout, "unlisted.env"), join(root, "unlisted.env"));
  return { root, checkout };
}

function envFiles(root: string): EnvFiles {
  return new EnvFiles(root, files, "app/.env", deploySettings.hubPasswordMinLength);
}

const noMatter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.reject(new MatterNotReadyError()),
  register: () => Promise.reject(new MatterNotReadyError()),
  rename: () => Promise.reject(new MatterNotReadyError()),
  commission: () => Promise.reject(new MatterNotReadyError()),
  setWiFiCredentials: () => Promise.reject(new MatterNotReadyError()),
  setThreadDataset: () => Promise.reject(new MatterNotReadyError()),
  removeNode: () => Promise.reject(new MatterNotReadyError()),
};

/** A fake GitHub API with one push run of the deploy workflow on main. */
class FakeGitHub {
  attempt = 1;
  status = "completed";
  conclusion: string | null = "success";
  runs = true;
  reruns = 0;
  authorizations: string[] = [];
  queries: string[] = [];

  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://fake");
    this.authorizations.push(req.headers.authorization ?? "");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === null ? "" : JSON.stringify(body));
    };
    const base = `/repos/${deploySettings.repo}/actions`;
    const workflow = deploySettings.workflow.split("/").at(-1) ?? "";
    const run = () => ({
      id: 42,
      html_url: "https://example.test/runs/42",
      run_attempt: this.attempt,
      status: this.status,
      conclusion: this.conclusion,
    });
    if (req.method === "GET" && url.pathname === `${base}/workflows/${workflow}/runs`) {
      this.queries.push(url.search);
      send(200, { workflow_runs: this.runs ? [run()] : [] });
    } else if (req.method === "POST" && url.pathname === `${base}/runs/42/rerun`) {
      this.reruns++;
      this.attempt++;
      this.status = "queued";
      this.conclusion = null;
      send(201, null);
    } else if (req.method === "GET" && url.pathname === `${base}/runs/42`) {
      send(200, run());
    } else {
      send(404, { message: "Not Found" });
    }
  };
}

interface Env {
  url: string;
  owner: string;
  account: string;
  root: string;
  checkout: string;
  fake: FakeGitHub;
}

async function setup(token: string | null = deployToken): Promise<Env> {
  const { root, checkout } = release(token);
  const fake = new FakeGitHub();
  const fakeUrl = await serve(fake.handle);
  const accounts = new Accounts(":memory:");
  const { token: invite } = accounts.createInvite();
  await accounts.join(invite, "guest", "guest password for the test");
  accounts.setScopes("guest", ["lights", "devices", "manage"]);
  const workflow = new DeployWorkflow({
    api: fakeUrl,
    repo: deploySettings.repo,
    workflow: deploySettings.workflow,
    timeoutMs: 5000,
  });
  const api = new Api(new Hub(), noMatter, ownerPassword, accounts, silentLog, undefined, undefined, undefined, {
    files: envFiles(root),
    workflow,
  });
  const url = await serve(api.handle);
  const login = await fetch(url + "/api/login", { method: "POST", body: JSON.stringify({ password: ownerPassword }) });
  const owner = new Fields(parseJson(await login.text()), "login").string("token") ?? "";
  return { url, owner, account: accounts.createSession("guest"), root, checkout, fake };
}

async function call(
  env: Env,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: Fields }> {
  const res = await fetch(env.url + path, {
    method,
    headers: token === "" ? {} : { Authorization: `Bearer ${token}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: new Fields(text === "" ? {} : parseJson(text), "answer") };
}

test("saving writes the link's target atomically, keeps the link and the mode", async () => {
  const { root, checkout } = release();
  const secrets = envFiles(root);
  await secrets.save("app/.env", [
    { key: "HUB_SECRET", value: "changed" },
    { key: "ADDED", value: "new" },
  ]);
  assert.ok(lstatSync(join(root, "app/.env")).isSymbolicLink(), "the release keeps its symlink");
  assert.equal(statSync(join(checkout, "app/.env")).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(join(checkout, "app/.env"), "utf8"),
    `# The hub's secrets.\nHUB_PASSWORD=${ownerPassword}\nHUB_SECRET=changed\nEMPTY=\nADDED=new\n`,
  );
  assert.deepEqual(readdirSync(join(checkout, "app")), [".env"], "no temporary file is left behind");
  chmodSync(join(checkout, "net/.env"), 0o640);
  await secrets.save("net/.env", [{ key: "TAILSCALE_API_KEY", value: "other" }]);
  assert.equal(statSync(join(checkout, "net/.env")).mode & 0o777, 0o640, "the target's own mode is kept");
});

test("only listed files can be read or written", async () => {
  const { root, checkout } = release();
  const secrets = envFiles(root);
  const refused = (err: unknown) => err instanceof SecretsError && err.status === 400;
  for (const file of ["unlisted.env", "../checkout/unlisted.env", "app/../unlisted.env", "/etc/passwd", ""]) {
    await assert.rejects(secrets.reveal(file, "OTHER"), refused, file);
    await assert.rejects(secrets.save(file, [{ key: "OTHER", value: "x" }]), refused, file);
  }
  assert.equal(readFileSync(join(checkout, "unlisted.env"), "utf8"), "OTHER=not-editable\n");
  assert.deepEqual(
    (await secrets.list()).map((file) => file.file),
    files,
  );
});

test("the listing masks every value and names keys in file order", async () => {
  const env = await setup();
  const listed = await call(env, env.owner, "GET", "/api/secrets");
  assert.equal(listed.status, 200);
  for (const secret of [hubSecret, tailnetSecret, ownerPassword, deployToken]) {
    assert.ok(!listed.text.includes(secret), "the listing contains no value");
  }
  assert.deepEqual(parseJson(listed.text), {
    files: [
      {
        file: "app/.env",
        exists: true,
        keys: [
          { key: "HUB_PASSWORD", masked: mask, hasValue: true },
          { key: "HUB_SECRET", masked: mask, hasValue: true },
          { key: "EMPTY", masked: "", hasValue: false },
          { key: tokenKey, masked: mask, hasValue: true },
        ],
      },
      { file: "net/.env", exists: true, keys: [{ key: "TAILSCALE_API_KEY", masked: mask, hasValue: true }] },
    ],
    redeploy: {
      available: true,
      tokenFile: settings.secrets.tokenFile,
      pollSeconds: settings.secrets.redeployPollSeconds,
    },
  });
});

test("only the owner can use the Secrets API", async () => {
  const env = await setup();
  const routes = [
    ["GET", "/api/secrets", undefined],
    ["PUT", "/api/secrets", { file: "app/.env", changes: [{ key: "A", value: "1" }], password: ownerPassword }],
    ["POST", "/api/secrets/reveal", { file: "app/.env", key: "HUB_SECRET", password: ownerPassword }],
    ["POST", "/api/secrets/redeploy", { password: ownerPassword }],
    ["GET", "/api/secrets/redeploy/42", undefined],
  ] as const;
  for (const [method, path, body] of routes) {
    const refused = await call(env, env.account, method, path, body);
    assert.equal(refused.status, 403, `an account with every scope: ${method} ${path}`);
    assert.ok(!refused.text.includes(hubSecret));
    assert.equal((await call(env, "", method, path, body)).status, 401, `signed out: ${method} ${path}`);
  }
  assert.equal(env.fake.reruns, 0);
  assert.ok(readFileSync(join(env.checkout, "app/.env"), "utf8").includes(`HUB_SECRET=${hubSecret}\n`));
});

test("reveal, save and redeploy refuse a wrong password", async () => {
  const env = await setup();
  const before = readFileSync(join(env.checkout, "app/.env"), "utf8");
  const wrong = "not the owner password";
  const reveal = await call(env, env.owner, "POST", "/api/secrets/reveal", {
    file: "app/.env",
    key: "HUB_SECRET",
    password: wrong,
  });
  assert.equal(reveal.status, 403);
  assert.ok(!reveal.text.includes(hubSecret));
  const save = await call(env, env.owner, "PUT", "/api/secrets", {
    file: "app/.env",
    changes: [{ key: "HUB_SECRET", value: "replaced" }],
    password: wrong,
  });
  assert.equal(save.status, 403);
  assert.equal(readFileSync(join(env.checkout, "app/.env"), "utf8"), before);
  assert.equal((await call(env, env.owner, "POST", "/api/secrets/redeploy", { password: wrong })).status, 403);
  assert.equal(env.fake.reruns, 0);
  assert.equal((await call(env, env.owner, "GET", "/api/session")).status, 200, "a wrong password keeps the session");

  for (let i = 0; i < 2; i++) {
    await call(env, env.owner, "POST", "/api/secrets/redeploy", { password: wrong });
  }
  const limited = await call(env, env.owner, "POST", "/api/secrets/reveal", {
    file: "app/.env",
    key: "HUB_SECRET",
    password: ownerPassword,
  });
  assert.equal(limited.status, 429, "wrong passwords count against the owner sign-in limit");
  assert.ok(!limited.text.includes(hubSecret));
  const login = await fetch(env.url + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(login.status, 429, "and block owner sign-in too");
});

test("the owner reveals a value and saves changes with the hub password", async () => {
  const env = await setup();
  const reveal = (file: string, key: string) =>
    call(env, env.owner, "POST", "/api/secrets/reveal", { file, key, password: ownerPassword });
  const revealed = await reveal("net/.env", "TAILSCALE_API_KEY");
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.string("value"), tailnetSecret);
  assert.equal((await reveal("net/.env", "MISSING")).status, 404);
  assert.equal((await reveal("unlisted.env", "OTHER")).status, 400);

  const save = (changes: unknown, file = "app/.env") =>
    call(env, env.owner, "PUT", "/api/secrets", { file, changes, password: ownerPassword });
  const saved = await save([
    { key: "HUB_SECRET", value: "rotated-value" },
    { key: "EMPTY", delete: true },
    { key: "ADDED", value: "added-value" },
  ]);
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes("rotated-value") && !saved.text.includes("added-value"), "the answer has no values");
  assert.equal(
    readFileSync(join(env.checkout, "app/.env"), "utf8"),
    `# The hub's secrets.\nHUB_PASSWORD=${ownerPassword}\nHUB_SECRET=rotated-value\n${tokenKey}=${deployToken}\nADDED=added-value\n`,
  );
  assert.ok(lstatSync(join(env.root, "app/.env")).isSymbolicLink());

  const injected = await save([{ key: "HUB_SECRET", value: "first-line\nSECOND=line" }]);
  assert.equal(injected.status, 400);
  assert.ok(!injected.text.includes("first-line"), "errors never echo values");
  assert.equal((await save([{ key: "lower", value: "x" }])).status, 400);
  const short = await save([{ key: "HUB_PASSWORD", value: "short-pass" }]);
  assert.equal(short.status, 400);
  assert.ok(!short.text.includes("short-pass"));
  assert.equal((await save([{ key: "A", value: "1" }], "unlisted.env")).status, 400);
  assert.equal((await save([{ key: "A", delete: false }])).status, 400);
  assert.equal((await save("not a list")).status, 400);
  assert.equal(readFileSync(join(env.checkout, "unlisted.env"), "utf8"), "OTHER=not-editable\n");
  const crossSite = await fetch(env.url + "/api/secrets/reveal", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.owner}`, Origin: "https://evil.example" },
    body: JSON.stringify({ file: "app/.env", key: "HUB_SECRET", password: ownerPassword }),
  });
  assert.equal(crossSite.status, 403, "cross-site requests are refused");
});

test("redeploy reruns the latest push run on main and reports its status", async () => {
  const env = await setup();
  const started = await call(env, env.owner, "POST", "/api/secrets/redeploy", { password: ownerPassword });
  assert.equal(started.status, 202);
  const run = { id: 42, url: "https://example.test/runs/42", attempt: 2 };
  assert.deepEqual(parseJson(started.text), { ...run, status: "queued", conclusion: null });
  assert.equal(env.fake.reruns, 1);
  assert.deepEqual(env.fake.queries, ["?branch=main&event=push&per_page=1"]);
  assert.ok(env.fake.authorizations.every((header) => header === `Bearer ${deployToken}`));

  const status = async () => parseJson((await call(env, env.owner, "GET", "/api/secrets/redeploy/42")).text);
  assert.deepEqual(await status(), { ...run, status: "queued", conclusion: null });
  env.fake.status = "completed";
  env.fake.conclusion = "success";
  assert.deepEqual(await status(), { ...run, status: "completed", conclusion: "success" });
  assert.equal((await call(env, env.owner, "GET", "/api/secrets/redeploy/0")).status, 400);
  assert.equal((await call(env, env.owner, "GET", "/api/secrets/redeploy/7")).status, 502, "GitHub's 404 is a 502");

  env.fake.runs = false;
  const none = await call(env, env.owner, "POST", "/api/secrets/redeploy", { password: ownerPassword });
  assert.equal(none.status, 404);
});

test("redeploy is unavailable until the token is saved on the page", async () => {
  const env = await setup(null);
  const available = async () =>
    new Fields((await call(env, env.owner, "GET", "/api/secrets")).body.value("redeploy"), "redeploy").bool(
      "available",
    );
  assert.equal(await available(), false);
  const refused = await call(env, env.owner, "POST", "/api/secrets/redeploy", { password: ownerPassword });
  assert.equal(refused.status, 409);
  assert.match(refused.body.string("error") ?? "", new RegExp(tokenKey));
  assert.equal((await call(env, env.owner, "GET", "/api/secrets/redeploy/42")).status, 409);
  assert.equal(env.fake.reruns, 0);

  const saved = await call(env, env.owner, "PUT", "/api/secrets", {
    file: "app/.env",
    changes: [{ key: tokenKey, value: deployToken }],
    password: ownerPassword,
  });
  assert.equal(saved.status, 200);
  assert.equal(await available(), true, "a saved token works without a restart");
  assert.equal((await call(env, env.owner, "POST", "/api/secrets/redeploy", { password: ownerPassword })).status, 202);
});

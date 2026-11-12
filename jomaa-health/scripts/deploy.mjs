#!/usr/bin/env node
// Deploys the health Worker and stores the hub password as its HUB_PASSWORD secret.
//   Cloudflare access: CLOUDFLARE_API_TOKEN, the token file ~/.config/jomaa-health/cloudflare-token
//   (mode 600), or else wrangler's own login (npx wrangler login)
//   HUB_PASSWORD from ../jomaa-home-hub/.env
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const tokenFile = join(homedir(), ".config/jomaa-health/cloudflare-token");
const envFile = new URL("../../jomaa-home-hub/.env", import.meta.url).pathname;

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function privateFile(path) {
  if ((statSync(path).mode & 0o077) !== 0) fail(`${path} must not be readable by other users (chmod 600)`);
  return readFileSync(path, "utf8");
}

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN };
  try {
    return { CLOUDFLARE_API_TOKEN: privateFile(tokenFile).trim() };
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function hubPassword() {
  for (const line of privateFile(envFile).split("\n")) {
    const match = /^\s*HUB_PASSWORD\s*=\s*(.*?)\s*$/.exec(line);
    if (match) return match[1].replace(/^(["'])(.*)\1$/, "$2");
  }
  fail(`HUB_PASSWORD is missing from ${envFile}`);
}

const password = hubPassword();
const env = { ...process.env, ...token(), WRANGLER_SEND_METRICS: "false" };
const wrangler = (args, input) => {
  const run = spawnSync("npx", ["wrangler", ...args], {
    cwd: here,
    env,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (run.status !== 0) fail(`wrangler ${args.join(" ")} failed`);
};

wrangler(["deploy"]);
wrangler(["secret", "put", "HUB_PASSWORD"], password);
console.log("Deployed https://health.jomaa.org");

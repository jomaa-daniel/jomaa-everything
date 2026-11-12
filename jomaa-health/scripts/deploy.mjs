#!/usr/bin/env node
// Deploys the health Worker and stores the hub password as its HUB_PASSWORD secret.
//   CLOUDFLARE_API_TOKEN, or the token file ~/.config/jomaa-health/cloudflare-token (mode 600)
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
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  try {
    return privateFile(tokenFile).trim();
  } catch (err) {
    if (err.code === "ENOENT") fail(`set CLOUDFLARE_API_TOKEN or save a Workers token in ${tokenFile}`);
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
const env = { ...process.env, CLOUDFLARE_API_TOKEN: token(), WRANGLER_SEND_METRICS: "false" };
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

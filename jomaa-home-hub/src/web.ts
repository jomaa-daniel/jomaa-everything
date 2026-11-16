import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scope } from "./accounts.js";

const html = "text/html; charset=utf-8";
const css = "text/css; charset=utf-8";
const js = "text/javascript; charset=utf-8";

/** Who can open a page: anyone, an account with the scope, or only the owner. */
export type PageAccess = Scope | "owner" | null | readonly Scope[];

/** The hub's pages by path, each with its file and who can open it. Each page is also served with a trailing slash. */
const pageFiles: Record<string, [string, PageAccess]> = {
  "/home": ["home.html", null],
  "/invite": ["invite.html", "owner"],
  "/join": ["join.html", null],
  "/permissions": ["permissions.html", "owner"],
  "/tailscale": ["tailscale.html", "owner"],
  "/secrets": ["secrets.html", "owner"],
  "/manage": ["manage.html", ["manage", "devices"]],
  "/lights": ["lights.html", "lights"],
};

/** The pages' scripts and styles by path. */
const assetFiles: Record<string, [string, string]> = {
  "/home/base.css": ["style.css", css],
  "/home/ui.css": ["ui.css", css],
  "/home/ui.js": ["ui.js", js],
  "/home/style.css": ["home.css", css],
  "/home/accounts.css": ["accounts.css", css],
  "/home/accounts.js": ["accounts.js", js],
  "/home/prefetch.js": ["prefetch.js", js],
  "/invite/app.js": ["invite.js", js],
  "/join/app.js": ["join.js", js],
  "/permissions/app.js": ["permissions.js", js],
  "/tailscale/app.js": ["tailscale.js", js],
  "/tailscale/style.css": ["tailscale.css", css],
  "/secrets/app.js": ["secrets.js", js],
  "/secrets/style.css": ["secrets.css", css],
  "/manage/app.js": ["manage.js", js],
  "/manage/health.js": ["health.js", js],
  "/manage/style.css": ["manage.css", css],
  "/lights/app.js": ["lights.js", js],
  "/lights/style.css": ["lights.css", css],
};

interface Resource {
  body: Buffer;
  type: string;
  etag: string;
}

function read(file: string): string {
  return readFileSync(new URL("./web/" + file, import.meta.url), "utf8");
}

function resource(text: string, type: string): Resource {
  const body = Buffer.from(text);
  return { body, type, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` };
}

/** Stylesheets and scripts a file loads, and the modules a script imports. */
const reference = /(<(?:link|script)\b[^>]*?\b(?:href|src)="|\b(?:from|import)\s*")(\/[^"]*)"/g;

/** The asset paths a file references, in order. */
function references(text: string): string[] {
  return [...text.matchAll(reference)].map((match) => match[2] ?? "").filter((path) => assetFiles[path] !== undefined);
}

const assets = new Map<string, Resource>();
/** Each asset's URL with its content version, so a changed file gets a new URL. */
const versions = new Map<string, string>();

/** Replaces each asset reference with its versioned URL. */
function withVersions(text: string): string {
  return text.replace(reference, (match: string, prefix: string, path: string) => {
    const asset = assetFiles[path];
    if (asset === undefined) return match;
    return `${prefix}${versioned(path, asset)}"`;
  });
}

function versioned(path: string, [file, type]: [string, string]): string {
  const known = versions.get(path);
  if (known !== undefined) return known;
  const loaded = resource(withVersions(read(file)), type);
  const url = `${path}?v=${loaded.etag.slice(1, -1)}`;
  assets.set(path, loaded);
  versions.set(path, url);
  return url;
}

for (const [path, asset] of Object.entries(assetFiles)) versioned(path, asset);

const pageResources = new Map<string, Resource>();
for (const [path, [file]] of Object.entries(pageFiles)) {
  const loaded = resource(withVersions(read(file)), html);
  pageResources.set(path, loaded);
  pageResources.set(path + "/", loaded);
}

/** The versioned URLs of the files a page loads, directly or through imports, in the order it references them. */
function assetsOf(file: string): string[] {
  const found: string[] = [];
  const pending = references(read(file));
  for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
    if (found.includes(path)) continue;
    found.push(path);
    const asset = assetFiles[path];
    if (asset !== undefined) pending.push(...references(read(asset[0])));
  }
  return found.map((path) => versions.get(path) ?? path);
}

/** A hub page, who can open it, and the files it loads. */
export interface Page {
  path: string;
  access: PageAccess;
  assets: string[];
}

export const pages: readonly Page[] = Object.entries(pageFiles).map(([path, [file, access]]) => ({
  path,
  access,
  assets: assetsOf(file),
}));

/** Whether an If-None-Match header names the entity tag, comparing weakly. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((tag) => {
    const trimmed = tag.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === etag;
  });
}

/** Serves the hub's public pages and their assets by path, revalidated by entity tag. */
export function serveWeb(req: IncomingMessage, res: ServerResponse): boolean {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    const destination = req.headers.host?.split(":")[0] === "jomaa.org" ? "/home" : "/manage";
    res.writeHead(302, { Location: destination, "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  const resource = pageResources.get(path) ?? assets.get(path);
  if (!resource) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  const caching = { "Cache-Control": "no-cache", ETag: resource.etag };
  if (matches(req.headers["if-none-match"], resource.etag)) {
    res.writeHead(304, caching);
    res.end();
    return true;
  }
  res.writeHead(200, {
    ...caching,
    "Content-Type": resource.type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(req.method === "HEAD" ? undefined : resource.body);
  return true;
}

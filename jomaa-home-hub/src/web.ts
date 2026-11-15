import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scope } from "./accounts.js";

const html = "text/html; charset=utf-8";
const css = "text/css; charset=utf-8";
const js = "text/javascript; charset=utf-8";

/** Who can open a page: anyone, an account with the scope, or only the owner. */
export type PageAccess = Scope | "owner" | null;

/** The hub's pages by path, each with its file and who can open it. Each page is also served with a trailing slash. */
const pageFiles: Record<string, [string, PageAccess]> = {
  "/home": ["home.html", null],
  "/invite": ["invite.html", "owner"],
  "/join": ["join.html", null],
  "/permissions": ["permissions.html", "owner"],
  "/secrets": ["secrets.html", "owner"],
  "/manage": ["manage.html", "manage"],
  "/devices": ["devices.html", "devices"],
  "/lights": ["lights.html", "lights"],
};

/** The pages' scripts and styles by path. */
const assetFiles: Record<string, [string, string]> = {
  "/home/base.css": ["style.css", css],
  "/home/style.css": ["home.css", css],
  "/home/accounts.css": ["accounts.css", css],
  "/home/accounts.js": ["accounts.js", js],
  "/home/prefetch.js": ["prefetch.js", js],
  "/invite/app.js": ["invite.js", js],
  "/join/app.js": ["join.js", js],
  "/permissions/app.js": ["permissions.js", js],
  "/secrets/app.js": ["secrets.js", js],
  "/secrets/style.css": ["secrets.css", css],
  "/manage/app.js": ["manage.js", js],
  "/manage/style.css": ["manage.css", css],
  "/devices/app.js": ["app.js", js],
  "/devices/style.css": ["style.css", css],
  "/lights/app.js": ["lights.js", js],
  "/lights/style.css": ["lights.css", css],
};

interface Resource {
  body: Buffer;
  type: string;
  etag: string;
}

function load(file: string, type: string): Resource {
  const body = readFileSync(new URL("./web/" + file, import.meta.url));
  return { body, type, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` };
}

const resources = new Map<string, Resource>();
for (const [path, [file]] of Object.entries(pageFiles)) {
  const resource = load(file, html);
  resources.set(path, resource);
  resources.set(path + "/", resource);
}
for (const [path, [file, type]] of Object.entries(assetFiles)) resources.set(path, load(file, type));

/** Stylesheets and scripts a page loads, and the modules those scripts import. */
const reference = /<(?:link|script)\b[^>]*?\b(?:href|src)="(\/[^"]*)"|\b(?:from|import)\s*"(\/[^"]*)"/g;

/** The served files a page loads, directly or through imports, in the order it references them. */
function assetsOf(path: string): string[] {
  const found: string[] = [];
  const pending = [path];
  for (let current = pending.shift(); current !== undefined; current = pending.shift()) {
    const text = resources.get(current)?.body.toString("utf8") ?? "";
    for (const match of text.matchAll(reference)) {
      const url = match[1] ?? match[2] ?? "";
      if (assetFiles[url] !== undefined && !found.includes(url)) {
        found.push(url);
        pending.push(url);
      }
    }
  }
  return found;
}

/** A hub page, who can open it, and the files it loads. */
export interface Page {
  path: string;
  access: PageAccess;
  assets: string[];
}

export const pages: readonly Page[] = Object.entries(pageFiles).map(([path, [, access]]) => ({
  path,
  access,
  assets: assetsOf(path),
}));

/** Whether an If-None-Match header names the entity tag, comparing weakly. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((tag) => {
    const trimmed = tag.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === etag;
  });
}

/** Serves the hub's public pages and their assets, revalidated by entity tag. */
export function serveWeb(req: IncomingMessage, res: ServerResponse): boolean {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    const destination = req.headers.host?.split(":")[0] === "jomaa.org" ? "/home" : "/devices";
    res.writeHead(302, { Location: destination, "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  const resource = resources.get(path);
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

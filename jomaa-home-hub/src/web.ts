import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

const files: Record<string, [string, string]> = {
  "/home": ["home.html", "text/html; charset=utf-8"],
  "/home/": ["home.html", "text/html; charset=utf-8"],
  "/home/base.css": ["style.css", "text/css; charset=utf-8"],
  "/home/style.css": ["home.css", "text/css; charset=utf-8"],
  "/home/accounts.css": ["accounts.css", "text/css; charset=utf-8"],
  "/home/accounts.js": ["accounts.js", "text/javascript; charset=utf-8"],
  "/invite": ["invite.html", "text/html; charset=utf-8"],
  "/invite/": ["invite.html", "text/html; charset=utf-8"],
  "/invite/app.js": ["invite.js", "text/javascript; charset=utf-8"],
  "/join": ["join.html", "text/html; charset=utf-8"],
  "/join/": ["join.html", "text/html; charset=utf-8"],
  "/join/app.js": ["join.js", "text/javascript; charset=utf-8"],
  "/permissions": ["permissions.html", "text/html; charset=utf-8"],
  "/permissions/": ["permissions.html", "text/html; charset=utf-8"],
  "/permissions/app.js": ["permissions.js", "text/javascript; charset=utf-8"],
  "/tailscale": ["tailscale.html", "text/html; charset=utf-8"],
  "/tailscale/": ["tailscale.html", "text/html; charset=utf-8"],
  "/tailscale/app.js": ["tailscale.js", "text/javascript; charset=utf-8"],
  "/tailscale/style.css": ["tailscale.css", "text/css; charset=utf-8"],
  "/manage": ["manage.html", "text/html; charset=utf-8"],
  "/manage/": ["manage.html", "text/html; charset=utf-8"],
  "/manage/app.js": ["manage.js", "text/javascript; charset=utf-8"],
  "/manage/style.css": ["manage.css", "text/css; charset=utf-8"],
  "/devices": ["devices.html", "text/html; charset=utf-8"],
  "/devices/": ["devices.html", "text/html; charset=utf-8"],
  "/devices/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/devices/style.css": ["style.css", "text/css; charset=utf-8"],
  "/lights": ["lights.html", "text/html; charset=utf-8"],
  "/lights/": ["lights.html", "text/html; charset=utf-8"],
  "/lights/app.js": ["lights.js", "text/javascript; charset=utf-8"],
  "/lights/style.css": ["lights.css", "text/css; charset=utf-8"],
};

/** Serves the hub's public pages and their assets. */
export function serveWeb(req: IncomingMessage, res: ServerResponse): boolean {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    const destination = req.headers.host?.split(":")[0] === "jomaa.org" ? "/home" : "/devices";
    res.writeHead(302, { Location: destination, "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  const file = files[path];
  if (!file) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  res.writeHead(200, {
    "Content-Type": file[1],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(req.method === "HEAD" ? undefined : readFileSync(new URL("./web/" + file[0], import.meta.url)));
  return true;
}

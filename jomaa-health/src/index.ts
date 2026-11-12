import { runChecks, type Report } from "./checks.ts";
import { renderPage } from "./page.ts";

interface Env {
  HUB_PASSWORD: string | undefined;
}

/** Reports are reused for this long, so page loads cannot flood the hub or Govee's API quota. */
const reportTtlSeconds = 60;
const cacheKey = "https://health.jomaa.org/__report";

let latest: Report | null = null;

/** Opens a WebSocket through the tunnel's SSH route and reads the server's greeting line. */
async function sshBanner(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers: { Upgrade: "websocket" }, signal });
  const socket = res.webSocket;
  if (socket === null) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}: the tunnel did not open a WebSocket`);
  }
  socket.binaryType = "arraybuffer";
  socket.accept();
  return new Promise<string>((resolve, reject) => {
    const decoder = new TextDecoder();
    let received = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      settle();
      try {
        socket.close(1000);
      } catch {
        // The socket is already closed.
      }
    };
    const aborted = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", aborted);
    socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data === "string") received += data;
      else if (data instanceof ArrayBuffer) received += decoder.decode(data, { stream: true });
      else return finish(() => reject(new Error("the SSH WebSocket sent an unknown frame type")));
      const end = received.indexOf("\n");
      if (end >= 0) finish(() => resolve(received.slice(0, end)));
    });
    socket.addEventListener("close", () => finish(() => reject(new Error("the tunnel closed before the SSH greeting"))));
    socket.addEventListener("error", () => finish(() => reject(new Error("the SSH WebSocket failed"))));
  });
}

async function freshReport(env: Env): Promise<Report> {
  return runChecks({
    fetch: (url, init) => fetch(url, { ...init, headers: { "User-Agent": "jomaa-health", ...init.headers } }),
    sshBanner,
    password: env.HUB_PASSWORD ?? "",
    now: () => Date.now(),
  });
}

async function report(env: Env, ctx: ExecutionContext): Promise<Report> {
  if (latest !== null && Date.now() - latest.checkedAt < reportTtlSeconds * 1000) return latest;
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) {
    const stored: Report = await cached.json();
    latest = stored;
    return stored;
  }
  const result = await freshReport(env);
  latest = result;
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${reportTtlSeconds}` },
      }),
    ),
  );
  return result;
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (path !== "/" && path !== "/checks.json") return new Response("not found", { status: 404 });
    const result = await report(env, ctx);
    const status = result.status === "fail" ? 503 : 200;
    if (path === "/checks.json") {
      return new Response(JSON.stringify(result, null, 2), {
        status,
        headers: { ...securityHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(renderPage(result, reportTtlSeconds), {
      status,
      headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;

import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { TLSSocket } from "node:tls";

/**
 * Slows password guessing once the hub is reachable from the internet. Each
 * client gets a few failed sign-ins per window, and all clients together get a
 * larger budget, so spreading guesses across many addresses doesn't help
 * either.
 */
export class LoginLimiter {
  readonly perClient = 5;
  readonly global = 50;
  readonly windowMs = 15 * 60 * 1000;
  now: () => number = Date.now;

  #clients = new Map<string, number[]>();
  #all: number[] = [];

  /** Whether client may try a password now, and if not, how many ms until it may. */
  allow(client: string): { ok: boolean; waitMs: number } {
    const now = this.now();
    this.#all = this.#recent(this.#all, now);
    const mine = this.#recent(this.#clients.get(client) ?? [], now);
    if (mine.length === 0) {
      this.#clients.delete(client);
    } else {
      this.#clients.set(client, mine);
    }
    const first = (times: number[]) => (times[0] ?? now) + this.windowMs - now;
    if (mine.length >= this.perClient) {
      return { ok: false, waitMs: first(mine) };
    }
    if (this.#all.length >= this.global) {
      return { ok: false, waitMs: first(this.#all) };
    }
    return { ok: true, waitMs: 0 };
  }

  /** Records a wrong password from client. */
  fail(client: string): void {
    const now = this.now();
    this.#clients.set(client, [...this.#recent(this.#clients.get(client) ?? [], now), now]);
    this.#all = [...this.#recent(this.#all, now), now];
    // Keep memory bounded if many addresses each fail once.
    if (this.#clients.size > 10_000) {
      for (const [c, times] of this.#clients) {
        if (this.#recent(times, now).length === 0) {
          this.#clients.delete(c);
        }
      }
    }
  }

  /** Clears client's failures after a correct password. */
  succeed(client: string): void {
    this.#clients.delete(client);
  }

  #recent(times: number[], now: number): number[] {
    const cutoff = now - this.windowMs;
    return times.filter((t) => t > cutoff);
  }
}

function isLoopback(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return (isIP(v4) === 4 && v4.startsWith("127.")) || address === "::1";
}

/**
 * Whether the request came from this machine, which is where cloudflared
 * runs. Only then are Cloudflare's forwarding headers trusted; from anywhere
 * else they could be forged.
 */
export function fromLocalProxy(req: IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress ?? "");
}

/**
 * The caller's address: Cloudflare's CF-Connecting-IP when the request came
 * through the local tunnel, otherwise the connection's address.
 */
export function clientIP(req: IncomingMessage): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (fromLocalProxy(req) && typeof forwarded === "string" && isIP(forwarded) !== 0) {
    return forwarded;
  }
  return req.socket.remoteAddress ?? "";
}

/**
 * Whether the client reached the hub over HTTPS, either directly or through
 * the tunnel, which terminates TLS at Cloudflare.
 */
export function isHTTPS(req: IncomingMessage): boolean {
  return req.socket instanceof TLSSocket || (fromLocalProxy(req) && req.headers["x-forwarded-proto"] === "https");
}

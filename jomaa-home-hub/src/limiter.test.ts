import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { test } from "node:test";
import { clientIP, isHTTPS, LoginLimiter } from "./limiter.js";

test("a client is blocked after five failures", () => {
  const l = new LoginLimiter();
  let now = 1_000_000_000;
  l.now = () => now;
  for (let i = 0; i < 5; i++) {
    assert.ok(l.allow("1.2.3.4").ok, `blocked after ${i} failures`);
    l.fail("1.2.3.4");
  }
  assert.deepEqual(l.allow("1.2.3.4"), { ok: false, waitMs: 15 * 60 * 1000 });
  assert.ok(l.allow("5.6.7.8").ok, "another client was blocked");
  now += 15 * 60 * 1000 + 1000;
  assert.ok(l.allow("1.2.3.4").ok, "still blocked after the window passed");
});

test("failures are capped across all clients", () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 50; i++) {
    l.fail(`client-${i}`);
  }
  assert.equal(l.allow("fresh-client").ok, false, "global budget not enforced");
});

test("success clears a client's failures", () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 4; i++) l.fail("me");
  l.succeed("me");
  for (let i = 0; i < 4; i++) l.fail("me");
  assert.ok(l.allow("me").ok, "failures before a successful sign-in still counted");
});

function request(remoteAddress: string, headers: Record<string, string>, tls = false): IncomingMessage {
  const proto: object = tls ? TLSSocket.prototype : Socket.prototype;
  const socket: unknown = Object.create(proto, { remoteAddress: { value: remoteAddress } });
  return { socket, headers } as unknown as IncomingMessage;
}

test("forwarded headers are only trusted from the local proxy", () => {
  const forwarded = { "cf-connecting-ip": "203.0.113.9", "x-forwarded-proto": "https" };
  const local = request("127.0.0.1", forwarded);
  assert.equal(clientIP(local), "203.0.113.9");
  assert.ok(isHTTPS(local), "tunnel request not seen as HTTPS");
  assert.equal(clientIP(request("::ffff:127.0.0.1", forwarded)), "203.0.113.9");

  const remote = request("192.168.1.50", forwarded);
  assert.equal(clientIP(remote), "192.168.1.50", "forged header trusted");
  assert.equal(isHTTPS(remote), false, "forged X-Forwarded-Proto trusted");

  assert.ok(isHTTPS(request("192.168.1.50", {}, true)), "direct TLS not seen as HTTPS");
  assert.equal(clientIP(request("127.0.0.1", { "cf-connecting-ip": "not an ip" })), "127.0.0.1");
});

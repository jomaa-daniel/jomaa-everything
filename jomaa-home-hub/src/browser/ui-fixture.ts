// Built pages with their API requests intercepted by Playwright.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Route } from "playwright-core";
import { serveWeb } from "../web.js";

export async function serveUi(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (serveWeb(req, res)) return;
    res.writeHead(req.url === "/favicon.ico" ? 204 : 404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

export interface ApiReply {
  status?: number;
  body: unknown;
}

type Handler = (call: ApiCall) => ApiReply | Promise<ApiReply>;

/** A separate mock API for each browser context. Unregistered requests fail the test. */
export class MockApi {
  readonly calls: ApiCall[] = [];
  readonly #handlers = new Map<string, Handler>();
  readonly #errors: string[] = [];
  readonly #scriptErrors: string[] = [];
  readonly #consoleErrors: { message: string; url: string }[] = [];
  readonly #failedUrls = new Set<string>();

  constructor(
    private readonly context: BrowserContext,
    private readonly origin: string,
  ) {}

  on(method: string, path: string, handler: Handler): void {
    this.#handlers.set(`${method} ${path}`, handler);
  }

  reply(method: string, path: string, body: unknown, status = 200): void {
    this.on(method, path, () => ({ status, body }));
  }

  mutations(): ApiCall[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  async install(): Promise<void> {
    this.context.on("page", (page) => {
      page.on("pageerror", (error) => this.#scriptErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error")
          this.#consoleErrors.push({ message: message.text(), url: message.location().url });
      });
    });
    await this.context.route("**/*", async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== this.origin) {
        this.#errors.push(`Unexpected external request: ${request.method()} ${url.href}`);
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        await route.continue();
        return;
      }
      const call = {
        method: request.method(),
        path: url.pathname + url.search,
        body: request.postData() === null ? undefined : (request.postDataJSON() as unknown),
      };
      this.calls.push(call);
      try {
        const handler = this.#handlers.get(`${call.method} ${call.path}`);
        assert.ok(handler, `Unmocked API request: ${call.method} ${call.path}`);
        const reply = await handler(call);
        const status = reply.status ?? 200;
        if (status >= 400) this.#failedUrls.add(url.href);
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(reply.body) });
      } catch (error) {
        this.#errors.push(error instanceof Error ? error.message : String(error));
        await route.fulfill({ status: 500, json: { error: "Unexpected API request" } });
      }
    });
  }

  assertHealthy(): void {
    assert.deepEqual(this.#errors, [], "every API request is mocked with the expected payload");
    assert.deepEqual(this.#scriptErrors, [], "the pages have no uncaught JavaScript errors");
    assert.deepEqual(
      this.#consoleErrors.filter(
        (error) => !this.#failedUrls.has(error.url) || !error.message.startsWith("Failed to load resource:"),
      ),
      [],
      "console errors belong only to deliberately refused API requests",
    );
  }
}

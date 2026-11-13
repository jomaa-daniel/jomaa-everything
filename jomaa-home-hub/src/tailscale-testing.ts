// Test support: the fake Tailscale provider from jomaa-tailscale/fake_tailnet.py,
// reached through the real tailnet.py and an isolated deployment directory.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CommandGateway, scriptPath } from "./tailscale-gateway.js";

const run = promisify(execFile);
const script = join(dirname(scriptPath()), "fake_tailnet.py");

export interface FakeUser {
  id: string;
  loginName: string;
  displayName: string;
  type: string;
  role: string;
  status: string;
}

export interface FakeState {
  users: FakeUser[];
  devices: Record<string, unknown>[];
  policy: { groups: Record<string, string[]>; grants: unknown[]; tests: unknown[] } & Record<string, unknown>;
  status: Record<string, unknown>;
  prefs: Record<string, unknown>;
  faults: Record<string, (string | null)[]>;
  writes: unknown[];
  reads: number;
}

export const fakeUsers: FakeUser[] = [
  { id: "u1", loginName: "alice@example.com", displayName: "Alice", type: "member", role: "member", status: "active" },
  { id: "u2", loginName: "bob@example.com", displayName: "Bob", type: "member", role: "member", status: "active" },
  { id: "u3", loginName: "owner@example.com", displayName: "Owner", type: "member", role: "owner", status: "active" },
  { id: "u4", loginName: "carol@example.com", displayName: "Carol", type: "member", role: "member", status: "active" },
  { id: "u9", loginName: "alice@example.com", displayName: "Alice", type: "shared", role: "member", status: "active" },
];

export const fakeDevices = [
  {
    id: "d1",
    name: "alice-phone",
    hostname: "alice-phone",
    user: "alice@example.com",
    os: "iOS",
    tags: [],
    lastSeen: "2026-11-13T10:00:00Z",
    expires: "2027-05-01T00:00:00Z",
    keyExpiryDisabled: false,
    authorized: true,
    connectedToControl: true,
  },
  {
    id: "d2",
    name: "alice-laptop",
    hostname: "alice-laptop",
    user: "alice@example.com",
    os: "macOS",
    tags: [],
    lastSeen: "2026-11-12T10:00:00Z",
    authorized: true,
  },
  {
    id: "d3",
    name: "jerry",
    hostname: "jerry",
    user: "alice@example.com",
    os: "linux",
    tags: ["tag:jerry"],
    keyExpiryDisabled: true,
    advertisedRoutes: ["192.168.1.0/24", "0.0.0.0/0", "::/0"],
    enabledRoutes: ["192.168.1.0/24"],
  },
  { id: "d4", name: "bob-tablet", hostname: "bob-tablet", user: "bob@example.com", os: "android", tags: [] },
];

export class FakeTailnet {
  readonly directory: string;
  readonly statePath: string;
  readonly deployHome: string;

  private constructor(directory: string) {
    this.directory = directory;
    this.statePath = join(directory, "provider.json");
    this.deployHome = join(directory, "deploy");
  }

  /** A provider whose policy is the committed template with the given family members. */
  static async create(family: string[] = []): Promise<FakeTailnet> {
    const fake = new FakeTailnet(mkdtempSync(join(tmpdir(), "hub-tailnet-")));
    writeFileSync(fake.statePath, JSON.stringify({}));
    const { stdout } = await run("python3", [script, fake.statePath, "render", ...family], { env: fake.env() });
    const policy: unknown = JSON.parse(stdout);
    fake.write({
      users: fakeUsers,
      devices: fakeDevices,
      policy,
      status: {
        BackendState: "Running",
        Self: { Online: true, Tags: ["tag:jerry"] },
        CurrentTailnet: { Name: "example.com" },
      },
      prefs: { AdvertiseRoutes: ["192.168.1.0/24", "0.0.0.0/0", "::/0"] },
      faults: {},
      writes: [],
      reads: 0,
    });
    return fake;
  }

  env(): Record<string, string> {
    return { PATH: process.env["PATH"] ?? "", JOMAA_DEPLOY_HOME: this.deployHome };
  }

  state(): FakeState {
    return JSON.parse(readFileSync(this.statePath, "utf8")) as FakeState;
  }

  write(state: unknown): void {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  update(change: (state: FakeState) => void): void {
    const state = this.state();
    change(state);
    this.write(state);
  }

  family(): string[] {
    return this.state().policy.groups["group:family"] ?? [];
  }

  gateway(database: string, timeoutMs = 30_000): CommandGateway {
    return new CommandGateway(["python3", script, this.statePath], database, timeoutMs, this.env());
  }
}

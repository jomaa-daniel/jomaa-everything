// Account and Tailscale setup as observable steps. Each module reports the
// steps' state and refuses an action its current state doesn't allow before
// anything changes.
import { type Account, type Accounts, type Scope, scopes as allScopes } from "./accounts.js";
import type { UserService } from "./users.js";
import type { AccessState, TailscaleService } from "./tailscale.js";
import { TailscaleError } from "./tailscale-store.js";

export type StepState = "complete" | "pending" | "waiting" | "blocked" | "failed" | "not-started" | "unknown";

export interface Step {
  id: string;
  title: string;
  state: StepState;
  detail: string;
}

export interface OnboardingStatus {
  steps: Step[];
  /** What to do next, or null when nothing is left. */
  next: string | null;
}

/** A refused transition; the state is unchanged. */
export class OnboardingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export abstract class OnboardingModule<Action extends { type: string }, Result> {
  /** The steps of a subject's setup. */
  abstract status(subject: string): OnboardingStatus;

  /** Validates the action against the current status, then performs it. */
  async advance(subject: string, action: Action): Promise<Result> {
    this.validateTransition(subject, action);
    return this.perform(subject, action);
  }

  /** Throws an OnboardingError when the action is not allowed now. */
  protected abstract validateTransition(subject: string, action: Action): void;

  protected abstract perform(subject: string, action: Action): Promise<Result>;
}

function nextStep(steps: Step[]): string | null {
  const open = steps.find((step) => step.state !== "complete");
  return open ? open.detail : null;
}

export type AccountAction =
  { type: "join"; token: string; password: string } | { type: "set-scopes"; scopes: Scope[] } | { type: "delete" };

/** Creating an account from an invite and granting it pages. Creating one grants nothing. */
export class AccountOnboarding extends OnboardingModule<AccountAction, Account | null> {
  constructor(private readonly users: UserService) {
    super();
  }

  status(username: string): OnboardingStatus {
    const account = this.users.accounts.account(username);
    if (!account) throw new OnboardingError(404, "Account not found");
    const names = allScopes.filter((scope) => account.scopes.includes(scope.id)).map((scope) => scope.name);
    const steps: Step[] = [
      { id: "account", title: "Account", state: "complete", detail: "Account created." },
      {
        id: "hub-access",
        title: "Hub pages",
        state: names.length ? "complete" : "not-started",
        detail: names.length ? `Can open ${names.join(", ")}.` : "No hub pages granted. Grant pages at /permissions.",
      },
    ];
    return { steps, next: nextStep(steps) };
  }

  protected validateTransition(username: string, action: AccountAction): void {
    // Joining validates the invite and the username in one transaction, so a
    // taken username is not revealed to someone without a valid invite.
    if (action.type === "join") return;
    this.status(username);
  }

  protected async perform(username: string, action: AccountAction): Promise<Account | null> {
    if (action.type === "join") return this.users.join(action.token, username, action.password);
    if (action.type === "set-scopes") return this.users.accounts.setScopes(username, action.scopes);
    this.users.deleteAccount(username);
    return null;
  }
}

export type TailscaleAction =
  { type: "link"; providerUserId: string } | { type: "unlink" } | { type: "grant" } | { type: "revoke" };

const accessSteps: Record<AccessState, Step> = {
  unlinked: { id: "access", title: "Exit-node access", state: "not-started", detail: "Link a Tailscale user first." },
  "no-access": { id: "access", title: "Exit-node access", state: "not-started", detail: "No exit-node access." },
  access: {
    id: "access",
    title: "Exit-node access",
    state: "complete",
    detail: "Tailscale's policy gives them access.",
  },
  giving: {
    id: "access",
    title: "Exit-node access",
    state: "pending",
    detail: "Access is saved; Tailscale's policy doesn't list them yet.",
  },
  removing: {
    id: "access",
    title: "Exit-node access",
    state: "pending",
    detail: "Removal is saved; Tailscale's policy still lists them.",
  },
};

/**
 * Setting up an account's exit-node access: link their Tailscale user, give
 * access, then they sign in on a device. Steps come from saved links and
 * Tailscale's policy and devices; which exit node a device uses is not
 * reported by Tailscale.
 */
export class TailscaleOnboarding extends OnboardingModule<TailscaleAction, unknown> {
  constructor(
    private readonly accounts: Accounts,
    private readonly tailscale: TailscaleService,
  ) {
    super();
  }

  #account(username: string): Account {
    const account = this.accounts.account(username);
    if (!account) throw new OnboardingError(404, "Account not found");
    return account;
  }

  status(username: string): OnboardingStatus {
    const profile = this.tailscale.profile(this.#account(username));
    const devices = profile.devices;
    const steps: Step[] = [
      { id: "account", title: "Account", state: "complete", detail: "Account created." },
      profile.link
        ? { id: "identity", title: "Tailscale user", state: "complete", detail: `Linked to ${profile.link.login}.` }
        : {
            id: "identity",
            title: "Tailscale user",
            state: "not-started",
            detail: "Invite them from the Tailscale admin console, then link their Tailscale user here.",
          },
      accessSteps[profile.access],
      devices.value === null
        ? {
            id: "device",
            title: "Device",
            state: "unknown",
            detail: `Devices unknown: ${devices.error ?? "not read yet"}.`,
          }
        : devices.value.length === 0
          ? {
              id: "device",
              title: "Device",
              state: "not-started",
              detail: "No device signed in yet. They install Tailscale and sign in with their own account.",
            }
          : {
              id: "device",
              title: "Device",
              state: devices.stale ? "unknown" : "complete",
              detail: `${devices.value.length} device(s) signed in${devices.stale ? " when last checked" : ""}.`,
            },
      {
        id: "exit-node",
        title: "Exit node chosen",
        state: "unknown",
        detail: "Tailscale doesn't report which exit node a device uses. They choose jerry under Exit node.",
      },
    ];
    return { steps, next: nextStep(steps.slice(0, 4)) };
  }

  protected validateTransition(username: string, action: TailscaleAction): void {
    const profile = this.tailscale.profile(this.#account(username));
    if (action.type === "link" && profile.link && profile.link.providerUserId !== action.providerUserId)
      throw new OnboardingError(409, `${username} is already linked to ${profile.link.login}. Unlink it first.`);
    if (action.type === "grant" && !profile.link)
      throw new OnboardingError(409, `Link ${username} to a Tailscale user before giving exit-node access.`);
  }

  protected async perform(username: string, action: TailscaleAction): Promise<unknown> {
    const account = this.#account(username);
    try {
      if (action.type === "link") return await this.tailscale.link(account, action.providerUserId);
      if (action.type === "unlink") {
        this.tailscale.unlink(account);
        return null;
      }
      return this.tailscale.setAccess(account, action.type === "grant");
    } catch (error) {
      if (error instanceof TailscaleError) throw new OnboardingError(error.status, error.message);
      throw error;
    }
  }
}

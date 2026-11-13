import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

const accessLabels = {
  unlinked: ["Not linked", "chip-neutral"],
  "no-access": ["No access", "chip-neutral"],
  access: ["Has access", "chip-green"],
  giving: ["Giving access…", "chip-blue"],
  removing: ["Removing access…", "chip-amber"],
};

const stepLabels = {
  complete: "Done",
  pending: "Not applied yet",
  "not-started": "To do",
  unknown: "Unknown",
};

let busy = false;
let focusUser = new URLSearchParams(location.search).get("user");

function age(timestamp) {
  if (timestamp === null) return "never";
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  return minutes < 1 ? "just now" : minutes < 90 ? `${minutes} min ago` : when(timestamp);
}

function observedText(observed) {
  if (observed.observedAt === null) return observed.error ? `Unknown: ${observed.error}` : "Not checked yet";
  const base = `Checked ${age(observed.observedAt)}`;
  if (observed.error) return `${base}; the latest check failed: ${observed.error}`;
  return observed.stale ? `${base} (out of date)` : base;
}

function facts(target, rows) {
  target.replaceChildren(...rows.flatMap(([term, value]) => [element("dt", term), element("dd", value)]));
}

function chip(state) {
  const [label, className] = accessLabels[state] ?? [state, "chip-neutral"];
  const node = element("span", label, `chip ${className}`);
  node.dataset.state = state;
  return node;
}

/** Runs one change, then shows the state saved on the hub. */
async function act(button, work) {
  if (busy) return;
  busy = true;
  const card = button?.closest("article")?.id;
  for (const control of document.querySelectorAll("#content button, #content select")) control.disabled = true;
  try {
    notify((await work()) ?? "Saved.", true);
  } catch (reason) {
    notify(reason.message);
  } finally {
    busy = false;
    await load().catch((reason) => notify(reason.message));
    const target = card ? document.querySelector(`#${CSS.escape(card)} h3`) : button;
    if (target?.isConnected) target.focus();
  }
}

function renderStatus(view) {
  const sync = view.sync;
  facts($("status"), [
    ["Managed access", sync.enabledAt ? `On since ${when(sync.enabledAt)}` : "Off"],
    ["Last sync", sync.syncedAt ? `${age(sync.syncedAt)}${sync.error ? `: ${sync.error}` : ", succeeded"}` : "Never"],
    ["Next sync", sync.syncing ? "Running now" : sync.nextSyncAt ? when(sync.nextSyncAt) : "After the next change"],
    ["Tailscale users", observedText(view.observed.users)],
  ]);
  $("enable-panel").hidden = sync.enabledAt !== null;
  const loss = view.wouldLoseAccess;
  $("enable-loss").textContent =
    loss === null
      ? "Tailscale's policy couldn't be read, so who has access now is unknown. Refresh to try again."
      : loss.length
        ? `These people have access now and will lose it: ${loss.join(", ")}. Link their accounts and give access first to keep it.`
        : "Nobody loses access.";
}

function renderServer(view) {
  const observed = view.observed.server;
  const server = observed.value;
  facts($("server"), [
    ["Checked", observedText(observed)],
    ...(server
      ? [
          [
            "Connection",
            server.backendState === "Running"
              ? `Running${server.online === false ? ", offline" : ""}`
              : (server.backendState ?? "Unknown"),
          ],
          ["Tag", server.tagged ? `Joined with ${server.tag}` : `Not joined with ${server.tag}`],
          ["Advertised routes", server.advertisedRoutes.join(", ") || "None"],
          ["Approved routes", server.approvedRoutes === null ? "Unknown" : server.approvedRoutes.join(", ") || "None"],
          ["Exit node in use", "Not reported by Tailscale"],
        ]
      : []),
  ]);
  $("server-problems").replaceChildren(
    ...(server?.problems ?? []).map((problem) =>
      element("li", `${problem}. Run jomaa-tailscale/setup_server.py on jerry with sudo; this page doesn't.`),
    ),
  );
}

function profileCard(profile, view) {
  const name = profile.username;
  const path = `/api/tailscale/profiles/${encodeURIComponent(name)}`;
  const card = element("article", undefined, "ts-profile");
  card.id = `profile-${name}`;
  const heading = element("h3", name);
  heading.tabIndex = -1;
  const title = element("div", undefined, "heading");
  title.append(heading, chip(profile.access));
  card.append(title);
  const link = profile.link;
  card.append(
    element("p", link ? `Tailscale user: ${link.displayName} (${link.login})` : "No Tailscale user linked.", "muted"),
  );
  if (["giving", "removing"].includes(profile.access) && view.sync.error)
    card.append(element("p", `Last sync failed: ${view.sync.error}`));
  if (profile.adminNote) card.append(element("p", profile.adminNote, "ts-note"));

  const row = element("div", undefined, "ts-row");
  if (link) {
    const toggle = element("button", link.access ? "Remove access" : "Give access", link.access ? "danger" : "primary");
    toggle.setAttribute(
      "aria-label",
      `${link.access ? "Remove exit-node access from" : "Give exit-node access to"} ${name}`,
    );
    toggle.addEventListener("click", () =>
      act(toggle, async () => {
        await api(`${path}/access`, "PUT", { access: !link.access });
        return link.access ? `Removal of ${name}'s access saved.` : `Access for ${name} saved.`;
      }),
    );
    const unlink = element("button", "Unlink");
    unlink.setAttribute("aria-label", `Unlink ${name} from Tailscale`);
    unlink.addEventListener("click", () =>
      act(unlink, async () => {
        if (!confirm(`Unlink ${name}? Their exit-node access is removed.`)) return "Nothing changed.";
        await api(`${path}/link`, "DELETE");
        return `Unlinked ${name}.`;
      }),
    );
    row.append(toggle, unlink);
  } else {
    const select = element("select");
    select.id = `user-${name}`;
    const label = element("label", `Tailscale user for ${name}`, "sr-only");
    label.htmlFor = select.id;
    const choices = view.providerUsers.filter((user) => user.linkedTo === null);
    const placeholder = element("option", choices.length ? "Choose a Tailscale user" : "No unlinked Tailscale users");
    placeholder.value = "";
    select.append(placeholder);
    for (const user of choices) {
      const option = element("option", `${user.displayName} (${user.login})`);
      option.value = user.id;
      select.append(option);
    }
    const linkButton = element("button", "Link");
    linkButton.setAttribute("aria-label", `Link a Tailscale user to ${name}`);
    linkButton.addEventListener("click", () =>
      act(linkButton, async () => {
        if (!select.value) throw new Error("Choose a Tailscale user first.");
        await api(`${path}/link`, "PUT", { providerUserId: select.value });
        return `Linked ${name}.`;
      }),
    );
    row.append(label, select, linkButton);
  }
  card.append(row);

  const steps = element("ol", undefined, "ts-steps");
  steps.setAttribute("aria-label", `Setup steps for ${name}`);
  for (const step of profile.onboarding.steps) {
    const item = element("li");
    item.dataset.step = step.id;
    item.dataset.state = step.state;
    item.append(
      element("span", `${step.title}: `),
      element("span", stepLabels[step.state] ?? step.state, "state"),
      ` — ${step.detail}`,
    );
    steps.append(item);
  }
  card.append(steps);

  if (link) {
    const devices = profile.devices;
    card.append(element("p", `Devices: ${observedText(devices)}`, "muted"));
    const list = element("ul", undefined, "ts-devices");
    for (const device of devices.value ?? []) {
      const connection =
        device.connected === null || devices.stale
          ? "connection unknown"
          : device.connected
            ? "connected"
            : "not connected";
      const seen = device.lastSeen ? `last seen ${when(Date.parse(device.lastSeen))}` : "last seen unknown";
      const expiry = device.keyExpiryDisabled
        ? "key doesn't expire"
        : device.expires
          ? `key expires ${when(Date.parse(device.expires))}`
          : "key expiry unknown";
      list.append(
        element("li", `${device.name}${device.os ? ` (${device.os})` : ""}: ${connection}, ${seen}, ${expiry}`),
      );
    }
    card.append(list);
  }
  return card;
}

function render(view) {
  renderStatus(view);
  renderServer(view);
  $("admin-users").href = view.setup.adminUsersUrl;
  $("download").href = view.setup.downloadUrl;
  $("profiles").replaceChildren(...view.profiles.map((profile) => profileCard(profile, view)));
  $("profiles-empty").hidden = view.profiles.length > 0;
  $("removing").replaceChildren(...view.removing.map((login) => element("li", login)));
  $("removing-section").hidden = view.removing.length === 0;
  if (focusUser) {
    const card = document.getElementById(`profile-${focusUser}`);
    if (card) {
      card.classList.add("focused");
      card.scrollIntoView({ block: "start" });
      card.querySelector("h3").focus();
    } else notify(`No account named ${focusUser}.`);
    focusUser = null;
  }
}

async function load() {
  render(await api("/api/tailscale"));
}

$("refresh").addEventListener("click", (event) =>
  act(event.currentTarget, async () => {
    await api("/api/tailscale/refresh", "POST", {});
    return "Refreshed.";
  }),
);

$("sync").addEventListener("click", (event) =>
  act(event.currentTarget, async () => {
    await api("/api/tailscale/sync", "POST", {});
    return "Syncing with Tailscale.";
  }),
);

$("enable").addEventListener("click", (event) =>
  act(event.currentTarget, async () => {
    if (!confirm("Turn on managed access? Tailscale's family group will list only the accounts here with access."))
      return "Nothing changed.";
    await api("/api/tailscale/enable", "POST", {});
    return "Managed access is on.";
  }),
);

ownerPage(load)();

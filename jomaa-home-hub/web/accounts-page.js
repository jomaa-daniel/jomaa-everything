import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

let catalog = [];
let routing = {};
let fields = [];
let scopeNames = new Map();
let entries = [];
let createdLink = null;
let selectedKey = selectionFromHash();
let detailGeneration = 0;
let loadGeneration = 0;
const inviteStates = { pending: "Unused", used: "Account created", expired: "Expired", revoked: "Revoked" };
const svgNamespace = "http://www.w3.org/2000/svg";

function svgElement(tag, attributes, text) {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function accessChart(activity) {
  const svg = svgElement("svg", { viewBox: "0 0 640 230", role: "img", "aria-labelledby": "access-title access-desc" });
  svg.append(
    svgElement("title", { id: "access-title" }, "Daily link opens (UTC)"),
    svgElement("desc", { id: "access-desc" }, activity.days.map((day) => `${day.date}: ${day.count} opens`).join("; ")),
  );
  const maximum = Math.max(1, ...activity.days.map((day) => day.count));
  for (const count of new Set([0, Math.ceil(maximum / 2), maximum])) {
    const y = 185 - (count / maximum) * 145;
    svg.append(
      svgElement("line", { x1: 45, x2: 625, y1: y, y2: y, class: "access-axis" }),
      svgElement("text", { x: 35, y: y + 4, "text-anchor": "end", class: "access-label" }, count),
    );
  }
  svg.append(svgElement("text", { x: 45, y: 20, class: "access-label" }, "Opens"));
  const width = 580 / Math.max(1, activity.days.length);
  activity.days.forEach((day, index) => {
    const height = (day.count / maximum) * 145;
    const bar = svgElement("rect", {
      x: 45 + index * width + width * 0.1,
      y: 185 - height,
      width: width * 0.8,
      height,
      class: "access-bar",
    });
    bar.append(svgElement("title", {}, `${day.date}: ${day.count} opens`));
    svg.append(bar);
  });
  const first = activity.days[0]?.date ?? "";
  const last = activity.days.at(-1)?.date ?? "";
  svg.append(
    svgElement("text", { x: 45, y: 210, class: "access-label" }, first),
    svgElement("text", { x: 625, y: 210, "text-anchor": "end", class: "access-label" }, last),
  );
  return svg;
}

function localDateTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function selectionFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has("invite")) return `invite:${params.get("invite")}`;
  if (params.has("account")) return `account:${params.get("account")}`;
  return null;
}

function columns(scopes, nodes) {
  return nodes.flatMap((node) =>
    scopes.filter((scope) => node.scopes.includes(scope.id)).map((scope) => ({ node, scope })),
  );
}

/** Links and the accounts they created share one row. Accounts without a link have their own row. */
function combinedEntries(accounts, invites) {
  const rows = invites.map((invite) => ({
    key: `invite:${invite.id}`,
    invite,
    account:
      accounts.find(
        (account) => account.username === invite.account?.username && account.createdAt === invite.account.createdAt,
      ) ?? null,
  }));
  const linked = new Set(rows.map((row) => row.account));
  rows.push(
    ...accounts
      .filter((account) => !linked.has(account))
      .map((account) => ({ key: `account:${account.username}`, invite: null, account })),
  );
  return rows.sort(
    (a, b) =>
      (b.invite?.createdAt ?? b.account.createdAt) - (a.invite?.createdAt ?? a.account.createdAt) ||
      a.key.localeCompare(b.key),
  );
}

function entryStatus(entry) {
  if (!entry.invite) return "Active account";
  if (entry.invite.status === "used" && !entry.account) return "Account deleted";
  return inviteStates[entry.invite.status];
}

function clearSelection() {
  const row = [...$("entries").children].find((row) => row.dataset.key === selectedKey);
  selectedKey = null;
  detailGeneration++;
  history.replaceState(null, "", location.pathname + location.search);
  $("details").hidden = true;
  $("link").value = "";
  updateSelection();
  row?.querySelector("button").focus();
}

function updateSelection() {
  for (const row of $("entries").children) {
    const selected = row.dataset.key === selectedKey;
    row.classList.toggle("selected", selected);
    row.querySelector("button").setAttribute("aria-expanded", String(selected));
  }
}

async function selectEntry(entry) {
  selectedKey = entry.key;
  const params = new URLSearchParams();
  params.set(entry.invite ? "invite" : "account", entry.invite?.id ?? entry.account.username);
  history.replaceState(null, "", "#" + params);
  updateSelection();
  await inspectDetails();
  $("details-heading").tabIndex = -1;
  $("details-heading").focus();
}

function entryRow(entry) {
  const row = element("tr");
  row.dataset.key = entry.key;
  if (entry.invite) row.dataset.inviteId = entry.invite.id;
  if (entry.account) row.dataset.account = entry.account.username;
  const cells = [
    entry.invite?.id ?? "—",
    entry.account?.username ?? entry.invite.account?.username ?? "Not created",
    entryStatus(entry),
    when(entry.invite?.createdAt ?? entry.account.createdAt),
    entry.invite ? when(entry.invite.expiresAt) : "—",
  ].map((text) => element("td", text));
  const actions = element("div", undefined, "row-actions");
  const inspect = element("button", "Inspect");
  inspect.setAttribute(
    "aria-label",
    entry.invite ? `Inspect link ${entry.invite.id}` : `Inspect account ${entry.account.username}`,
  );
  inspect.setAttribute("aria-controls", "details");
  inspect.setAttribute("aria-expanded", String(entry.key === selectedKey));
  inspect.addEventListener("click", () => selectEntry(entry));
  actions.append(inspect);
  if (entry.invite && (entry.invite.status === "pending" || entry.invite.status === "expired")) {
    const revoke = element("button", "Revoke", "danger");
    revoke.setAttribute("aria-label", `Revoke link ${entry.invite.id}`);
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try {
        await api(`/api/invites/${encodeURIComponent(entry.invite.id)}`, "DELETE");
        notify("Invite revoked.", true);
        await load();
      } catch (reason) {
        notify(reason.message);
        revoke.disabled = false;
      }
    });
    actions.append(revoke);
  }
  if (entry.account) {
    const username = entry.account.username;
    const remove = element("button", "Delete account", "danger");
    remove.setAttribute("aria-label", `Delete account ${username}`);
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete ${username}? They are signed out everywhere.`)) return;
      remove.disabled = true;
      try {
        await api(`/api/accounts/${encodeURIComponent(username)}`, "DELETE");
        notify(`Deleted ${username}.`, true);
        if (!entry.invite && selectedKey === entry.key) clearSelection();
        await load();
      } catch (reason) {
        notify(reason.message);
        remove.disabled = false;
      }
    });
    actions.append(remove);
  }
  const actionCell = element("td");
  actionCell.append(actions);
  row.append(...cells, actionCell);
  row.classList.toggle("selected", entry.key === selectedKey);
  row.addEventListener("click", (event) => {
    if (!event.target.closest("button")) selectEntry(entry);
  });
  return row;
}

function renderEntries() {
  $("entries").replaceChildren(...entries.map(entryRow));
  $("entries-empty").hidden = entries.length > 0;
}

/** Saves permissions for the selected unused link or its current account. */
function renderGrants(container, grants, prefix, entry, kind) {
  const generation = detailGeneration;
  const controls = [];
  const scopes = [...new Map(fields.map((field) => [field.scope.id, field.scope])).values()];
  for (const scope of scopes) {
    const options = fields.filter((field) => field.scope.id === scope.id);
    if (routing[scope.id] === "account") {
      const select = element("select");
      select.dataset.scope = scope.id;
      const identity = kind === "account" ? entry.account.username : `Link ${entry.invite.id}`;
      select.setAttribute("aria-label", `${identity} ${scope.name} node`);
      const choices = [{ id: "", name: "No access" }, ...options.map(({ node }) => node)];
      for (const node of choices) {
        const option = element("option", node.name);
        option.value = node.id;
        select.append(option);
      }
      const assigned = grants.filter((grant) => grant.scopes.includes(scope.id));
      if (assigned.length === 1) select.value = assigned[0].node;
      else if (assigned.length > 1) {
        const option = element("option", "Choose one node");
        option.value = "";
        option.disabled = true;
        option.selected = true;
        select.prepend(option);
      }
      const label = element("label");
      label.append(element("span", `${scope.name} node`), select);
      container.append(label);
      controls.push(select);
    } else {
      for (const { node } of options) {
        const box = element("input");
        box.type = "checkbox";
        box.dataset.node = node.id;
        box.dataset.scope = scope.id;
        box.checked = grants.some((grant) => grant.node === node.id && grant.scopes.includes(scope.id));
        box.setAttribute("aria-label", `${prefix} ${scope.name} at ${node.name}`);
        const label = element("label");
        label.append(box, element("span", `${scope.name} · ${node.name}`));
        container.append(label);
        controls.push(box);
      }
    }
  }
  const read = (control) => (control.tagName === "SELECT" ? control.value : control.checked);
  const selectedGrants = () => {
    const granted = new Map();
    for (const control of controls) {
      const node = control.tagName === "SELECT" ? control.value : control.checked ? control.dataset.node : "";
      if (!node) continue;
      if (!granted.has(node)) granted.set(node, []);
      granted.get(node).push(control.dataset.scope);
    }
    return [...granted].map(([node, scopes]) => ({ node, scopes }));
  };
  for (const control of controls) {
    let saved = read(control);
    control.addEventListener("change", async () => {
      for (const other of controls) other.disabled = true;
      try {
        const path =
          kind === "invite"
            ? `/api/invites/${encodeURIComponent(entry.invite.id)}/grants`
            : `/api/accounts/${encodeURIComponent(entry.account.username)}/grants`;
        const result = await api(path, "PUT", { grants: selectedGrants() });
        if (generation === detailGeneration) {
          entry[kind] = result[kind];
          saved = read(control);
          notify(kind === "invite" ? "Link access saved." : `Saved ${entry.account.username}.`, true);
        }
      } catch (reason) {
        if (control.tagName === "SELECT") control.value = saved;
        else control.checked = saved;
        if (reason.status === 404 || reason.status === 409) await load();
        notify(reason.message);
        if (entry.key === selectedKey) $("detail-notice").textContent = reason.message;
      } finally {
        if (generation === detailGeneration) for (const other of controls) other.disabled = false;
      }
    });
  }
}

function renderLinkAccess(entry) {
  $("link-access").hidden = false;
  const invite = entry.invite;
  const editable = invite.status === "pending" || invite.status === "expired";
  if (editable) {
    renderGrants($("invite-grants"), invite.grants, `Link ${invite.id} includes`, entry, "invite");
    $("link-access-help").textContent =
      "Changes save immediately. The account created from this link receives this access.";
  } else {
    const list = element("ul");
    for (const grant of invite.grants) {
      const home = catalog.find((node) => node.id === grant.node)?.name ?? grant.node;
      list.append(element("li", `${home}: ${grant.scopes.map((scope) => scopeNames.get(scope)).join(", ")}`));
    }
    $("invite-grants").append(invite.grants.length ? list : element("p", "No access included."));
    $("link-access-help").textContent =
      invite.status === "used"
        ? entry.account
          ? "Access granted at signup. Current permissions are below."
          : "Access granted at signup. This account was deleted."
        : "Revoked links cannot change access.";
  }
}

async function inspectDetails() {
  const key = selectedKey;
  const generation = ++detailGeneration;
  $("details").hidden = !key;
  if (!key) return;
  $("new-link").hidden = true;
  $("link").value = "";
  $("copy").disabled = true;
  $("entry-facts").replaceChildren();
  $("invite-grants").replaceChildren();
  $("account-grants").replaceChildren();
  $("link-access").hidden = true;
  $("account-access").hidden = true;
  $("link-details").hidden = true;
  $("invite-expiration").disabled = true;
  $("save-expiration").disabled = true;
  $("detail-notice").textContent = "Loading details…";
  const entry = entries.find((entry) => entry.key === key);
  if (!entry) {
    $("detail-notice").textContent = "This link or account was not found.";
    return;
  }
  try {
    let activity = null;
    if (entry.invite) {
      const result = await api(`/api/invites/${encodeURIComponent(entry.invite.id)}`);
      if (generation !== detailGeneration) return;
      entry.invite = result.invite;
      entry.account = result.account;
      activity = result.activity;
      renderEntries();
    }
    $("detail-notice").textContent = "";
    $("details-heading").textContent = entry.invite ? "Link details" : "Account details";
    const invite = entry.invite;
    const facts = invite
      ? [
          ["Link", invite.id],
          ["Status", entryStatus(entry)],
          ["Created", when(invite.createdAt)],
          ["Account created", invite.account ? "Yes" : "No"],
          ["Account name", invite.account?.username ?? "No account yet"],
          ["Account created at", invite.account ? when(invite.account.createdAt) : "—"],
          ["Expires", when(invite.expiresAt)],
          ["Last opened", activity.lastAccessAt === null ? "Never" : when(activity.lastAccessAt)],
        ]
      : [
          ["Account name", entry.account.username],
          ["Status", "Active account"],
          ["Created", when(entry.account.createdAt)],
          ["Link", "No link record"],
        ];
    if (invite && invite.revokedAt !== null) facts.push(["Revoked", when(invite.revokedAt)]);
    $("entry-facts").replaceChildren(
      ...facts.flatMap(([label, value]) => [element("dt", label), element("dd", value)]),
    );
    if (invite) {
      renderLinkAccess(entry);
      if (createdLink?.id === invite.id && (invite.status === "pending" || invite.status === "expired")) {
        $("new-link").hidden = false;
        $("link").value = createdLink.url;
        $("copy").disabled = false;
      }
    }
    if (entry.account) {
      $("account-access").hidden = false;
      renderGrants($("account-grants"), entry.account.grants, `${entry.account.username} can open`, entry, "account");
    }
    if (invite) {
      $("link-details").hidden = false;
      const editable = invite.status === "pending" || invite.status === "expired";
      $("invite-expiration").value = localDateTime(invite.expiresAt);
      $("invite-expiration").disabled = !editable;
      $("save-expiration").disabled = !editable;
      $("expiration-help").textContent = editable
        ? "Times use your local timezone. Extending an expired, unused link makes it usable again."
        : "Used and revoked links cannot change expiration.";
      $("access-summary").textContent =
        `${activity.total} opens in total · Daily counts in UTC, up to ${activity.chartDays} days.`;
      $("access-chart").replaceChildren(accessChart(activity));
      $("access-days").replaceChildren(
        ...activity.days.map((day) => {
          const row = element("tr");
          row.append(element("td", day.date), element("td", day.count));
          return row;
        }),
      );
    }
  } catch (reason) {
    if (generation === detailGeneration) $("detail-notice").textContent = reason.message;
  }
}

/** Loads one snapshot of accounts, links, and available access choices. */
async function load() {
  const generation = ++loadGeneration;
  const { accounts, invites, scopes, nodes, routing: policies } = await api("/api/accounts");
  if (generation !== loadGeneration) return;
  catalog = nodes;
  routing = policies;
  fields = columns(scopes, nodes);
  scopeNames = new Map(scopes.map((scope) => [scope.id, scope.name]));
  entries = combinedEntries(accounts, invites);
  renderEntries();
  await inspectDetails();
}

$("refresh-details").addEventListener("click", () => load().catch((reason) => notify(reason.message)));
$("close-details").addEventListener("click", clearSelection);
window.addEventListener("hashchange", () => {
  selectedKey = selectionFromHash();
  inspectDetails();
});
$("expiration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = entries.find((entry) => entry.key === selectedKey);
  if (!entry?.invite) return;
  $("save-expiration").disabled = true;
  try {
    await api(`/api/invites/${encodeURIComponent(entry.invite.id)}`, "PATCH", {
      expiresAt: new Date($("invite-expiration").value).getTime(),
    });
    notify("Link expiration saved.", true);
    await load();
  } catch (reason) {
    if (entry.key === selectedKey) {
      $("detail-notice").textContent = reason.message;
      $("save-expiration").disabled = false;
    }
  }
});

$("create").addEventListener("click", async () => {
  $("create").disabled = true;
  try {
    const { invite, token } = await api("/api/invites", "POST", { grants: [] });
    createdLink = { id: invite.id, url: `${location.origin}/join#${token}` };
    selectedKey = `invite:${invite.id}`;
    history.replaceState(null, "", `#invite=${encodeURIComponent(invite.id)}`);
    notify(`Link created; it expires ${when(invite.expiresAt)} and is shown only once.`, true);
    await load();
    $("details-heading").tabIndex = -1;
    $("details-heading").focus();
  } catch (reason) {
    notify(reason.message);
  } finally {
    $("create").disabled = false;
  }
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("link").value);
    notify("Link copied.", true);
  } catch {
    $("link").select();
    notify("Copy failed. Select the link and copy it.");
  }
});

ownerPage(load)();

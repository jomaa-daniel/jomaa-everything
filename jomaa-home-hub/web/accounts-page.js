import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

let catalog = [];
let selectedInvite = new URLSearchParams(location.hash.slice(1)).get("invite");
let detailGeneration = 0;
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

/** Opens the selected link's account information, access chart, and expiration editor. */
async function inspectInvite() {
  const id = selectedInvite;
  const generation = ++detailGeneration;
  $("invite-detail").hidden = !id;
  if (!id) return;
  $("invite-facts").replaceChildren();
  $("access-chart").replaceChildren();
  $("access-days").replaceChildren();
  $("access-summary").textContent = "";
  $("invite-expiration").value = "";
  $("invite-expiration").disabled = true;
  $("save-expiration").disabled = true;
  $("invite-notice").textContent = "Loading link details…";
  try {
    const { invite, activity } = await api(`/api/invites/${encodeURIComponent(id)}`);
    if (generation !== detailGeneration) return;
    $("invite-notice").textContent = "";
    const facts = [
      ["Link", invite.id],
      ["Status", inviteStates[invite.status]],
      ["Created", when(invite.createdAt)],
      ["Account created", invite.account ? "Yes" : "No"],
      ["Account name", invite.account?.username ?? "No account yet"],
      ["Account created at", invite.account ? when(invite.account.createdAt) : "—"],
      ["Expires", when(invite.expiresAt)],
      ["Last opened", activity.lastAccessAt === null ? "Never" : when(activity.lastAccessAt)],
    ];
    if (invite.revokedAt !== null) facts.push(["Revoked", when(invite.revokedAt)]);
    $("invite-facts").replaceChildren(
      ...facts.flatMap(([label, value]) => [element("dt", label), element("dd", value)]),
    );
    const editable = invite.status === "pending" || invite.status === "expired";
    $("invite-expiration").value = localDateTime(invite.expiresAt);
    $("invite-expiration").disabled = !editable;
    $("save-expiration").disabled = !editable;
    $("expiration-help").textContent = editable
      ? "Times use your local timezone. Extending an expired, unused link makes it usable again."
      : "Used and revoked links cannot change expiration. Account access is managed in Accounts above.";
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
    for (const row of $("invites").children) row.setAttribute("aria-current", String(row.dataset.id === id));
  } catch (reason) {
    if (generation === detailGeneration) $("invite-notice").textContent = reason.message;
  }
}

function columns(scopes, nodes) {
  return nodes.flatMap((node) =>
    scopes.filter((scope) => node.scopes.includes(scope.id)).map((scope) => ({ node, scope })),
  );
}

function grantsFrom(boxes, fields) {
  return catalog
    .map((node) => ({
      node: node.id,
      scopes: fields
        .filter((field, index) => field.node.id === node.id && boxes[index].checked)
        .map((field) => field.scope.id),
    }))
    .filter((grant) => grant.scopes.length > 0);
}

function accountRow(account, fields) {
  const tr = element("tr");
  const boxes = fields.map(({ node, scope }) => {
    const box = element("input");
    box.type = "checkbox";
    box.checked = account.grants.some((grant) => grant.node === node.id && grant.scopes.includes(scope.id));
    box.setAttribute("aria-label", `${account.username} can open ${scope.name} at ${node.name}`);
    return box;
  });
  for (const box of boxes)
    box.addEventListener("change", async () => {
      for (const other of boxes) other.disabled = true;
      try {
        await api(`/api/accounts/${encodeURIComponent(account.username)}/grants`, "PUT", {
          grants: grantsFrom(boxes, fields),
        });
        notify(`Saved ${account.username}.`, true);
      } catch (reason) {
        box.checked = !box.checked;
        notify(reason.message);
      } finally {
        for (const other of boxes) other.disabled = false;
      }
    });
  const remove = element("button", "Delete", "danger");
  remove.setAttribute("aria-label", `Delete account ${account.username}`);
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete ${account.username}? They are signed out everywhere.`)) return;
    remove.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(account.username)}`, "DELETE");
      notify(`Deleted ${account.username}.`, true);
      await load();
    } catch (reason) {
      notify(reason.message);
      remove.disabled = false;
    }
  });
  const cells = boxes.map((box) => {
    const cell = element("td", undefined, "scope-cell");
    const label = element("label");
    label.append(box);
    cell.append(label);
    return cell;
  });
  const actions = element("td", undefined, "row-actions");
  actions.append(remove);
  tr.append(element("td", account.username), ...cells, actions);
  return tr;
}

function inviteRow(invite) {
  const row = element("li");
  row.dataset.id = invite.id;
  row.setAttribute("aria-current", String(invite.id === selectedInvite));
  const permissions = invite.grants
    .map((grant) => `${catalog.find((node) => node.id === grant.node)?.name ?? grant.node}: ${grant.scopes.join(", ")}`)
    .join("; ");
  const label = element(
    "span",
    `Link ${invite.id} · ${inviteStates[invite.status]}${invite.account ? ` · ${invite.account.username}` : ""}. ${permissions || "No access"}. Created ${when(invite.createdAt)}, expires ${when(invite.expiresAt)}`,
  );
  const inspect = element("button", "Inspect");
  inspect.setAttribute("aria-label", `Inspect link ${invite.id}`);
  inspect.addEventListener("click", async () => {
    selectedInvite = invite.id;
    history.replaceState(null, "", `#invite=${encodeURIComponent(invite.id)}`);
    await inspectInvite();
    $("invite-detail-heading").tabIndex = -1;
    $("invite-detail-heading").focus();
  });
  const revoke = element("button", "Revoke", "danger");
  revoke.disabled = invite.status === "used" || invite.status === "revoked";
  revoke.setAttribute("aria-label", `Revoke invite created ${when(invite.createdAt)}`);
  revoke.addEventListener("click", async () => {
    revoke.disabled = true;
    try {
      await api(`/api/invites/${encodeURIComponent(invite.id)}`, "DELETE");
      notify("Invite revoked.", true);
      await load();
    } catch (reason) {
      notify(reason.message);
      revoke.disabled = false;
    }
  });
  row.append(label, inspect, revoke);
  return row;
}

/** Shows per-node account grants and retained invitation history. */
async function load() {
  const [{ accounts, scopes, nodes }, { invites }] = await Promise.all([api("/api/accounts"), api("/api/invites")]);
  catalog = nodes;
  const fields = columns(scopes, nodes);
  const cells = ["Account", ...fields.map(({ node, scope }) => `${scope.name} · ${node.name}`)].map((text) =>
    element("th", text),
  );
  const actions = element("th");
  actions.append(element("span", "Actions", "sr-only"));
  $("scope-head").replaceChildren(...cells, actions);
  $("account-rows").replaceChildren(...accounts.map((account) => accountRow(account, fields)));
  $("accounts-empty").hidden = accounts.length > 0;
  $("invites").replaceChildren(...invites.map(inviteRow));
  $("invites-empty").hidden = invites.length > 0;
  if (!$("invite-grants").children.length)
    for (const { node, scope } of fields) {
      const label = element("label");
      const box = element("input");
      box.type = "checkbox";
      box.dataset.node = node.id;
      box.dataset.scope = scope.id;
      label.append(box, element("span", `${scope.name} · ${node.name}`));
      $("invite-grants").append(label);
    }
  await inspectInvite();
}

$("refresh-invite").addEventListener("click", inspectInvite);
$("close-invite").addEventListener("click", () => {
  const row = [...$("invites").children].find((row) => row.dataset.id === selectedInvite);
  selectedInvite = null;
  detailGeneration++;
  history.replaceState(null, "", location.pathname + location.search);
  $("invite-detail").hidden = true;
  row?.querySelector("button").focus();
  for (const row of $("invites").children) row.setAttribute("aria-current", "false");
});
window.addEventListener("hashchange", () => {
  selectedInvite = new URLSearchParams(location.hash.slice(1)).get("invite");
  inspectInvite();
});
$("expiration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = selectedInvite;
  if (!id) return;
  $("save-expiration").disabled = true;
  try {
    await api(`/api/invites/${encodeURIComponent(id)}`, "PATCH", {
      expiresAt: new Date($("invite-expiration").value).getTime(),
    });
    notify("Link expiration saved.", true);
    await load();
  } catch (reason) {
    if (id === selectedInvite) {
      $("invite-notice").textContent = reason.message;
      $("save-expiration").disabled = false;
    }
  }
});

$("create").addEventListener("click", async () => {
  $("create").disabled = true;
  try {
    const boxes = [...$("invite-grants").querySelectorAll("input")];
    const grants = catalog
      .map((node) => ({
        node: node.id,
        scopes: boxes.filter((box) => box.checked && box.dataset.node === node.id).map((box) => box.dataset.scope),
      }))
      .filter((grant) => grant.scopes.length > 0);
    const { invite, token } = await api("/api/invites", "POST", { grants });
    $("link").value = `${location.origin}/join#${token}`;
    $("copy").disabled = false;
    $("link").select();
    notify(`Link created; it expires ${when(invite.expiresAt)} and is shown only once.`, true);
    await load();
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

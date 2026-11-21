import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

let catalog = [];

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
  const permissions = invite.grants
    .map((grant) => `${catalog.find((node) => node.id === grant.node)?.name ?? grant.node}: ${grant.scopes.join(", ")}`)
    .join("; ");
  const label = element(
    "span",
    `${permissions || "No access"}. Created ${when(invite.createdAt)}, expires ${when(invite.expiresAt)}`,
  );
  const revoke = element("button", "Revoke", "danger");
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
  row.append(label, revoke);
  return row;
}

/** Shows per-node account grants and the permissions carried by unused invitations. */
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
}

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

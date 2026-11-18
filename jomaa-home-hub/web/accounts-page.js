import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

function heading(scopes) {
  const cells = ["Account", ...scopes.map((scope) => scope.name)].map((text) => element("th", text));
  for (const cell of cells.slice(1)) cell.className = "scope-cell";
  const actions = element("th");
  actions.append(element("span", "Actions", "sr-only"));
  $("scope-head").replaceChildren(...cells, actions);
}

function accountRow(account, scopes) {
  const tr = element("tr");
  const boxes = scopes.map((scope) => {
    const box = element("input");
    box.type = "checkbox";
    box.checked = account.scopes.includes(scope.id);
    box.setAttribute("aria-label", `${account.username} can open ${scope.name}`);
    return box;
  });
  for (const box of boxes) {
    box.addEventListener("change", async () => {
      for (const other of boxes) other.disabled = true;
      try {
        await api(`/api/accounts/${encodeURIComponent(account.username)}/scopes`, "PUT", {
          scopes: scopes.filter((_, index) => boxes[index].checked).map((scope) => scope.id),
        });
        notify(`Saved ${account.username}.`, true);
      } catch (reason) {
        box.checked = !box.checked;
        notify(reason.message);
      } finally {
        for (const other of boxes) other.disabled = false;
      }
    });
  }
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
  const label = element("span", `Created ${when(invite.createdAt)}, expires ${when(invite.expiresAt)}`);
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

/** Shows every account with its scopes and every unused invite. */
async function load() {
  const [{ accounts, scopes }, { invites }] = await Promise.all([api("/api/accounts"), api("/api/invites")]);
  heading(scopes);
  $("account-rows").replaceChildren(...accounts.map((account) => accountRow(account, scopes)));
  $("accounts-empty").hidden = accounts.length > 0;
  $("invites").replaceChildren(...invites.map(inviteRow));
  $("invites-empty").hidden = invites.length > 0;
}

$("create").addEventListener("click", async () => {
  $("create").disabled = true;
  try {
    const { invite, token } = await api("/api/invites", "POST", {});
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

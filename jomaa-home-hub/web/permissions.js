import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

/** Unsaved checkbox changes by username. */
const drafts = new Map();

function heading(scopes) {
  const account = element("th", "Account");
  account.scope = "col";
  const columns = scopes.map((scope) => {
    const cell = element("th", scope.name, "scope-cell");
    cell.scope = "col";
    cell.title = scope.description;
    return cell;
  });
  const actions = element("th");
  actions.append(element("span", "Actions", "sr-only"));
  $("scope-head").replaceChildren(account, ...columns, actions);
}

function row(account, scopes) {
  const granted = new Set(drafts.get(account.username) ?? account.scopes);
  const tr = element("tr");
  const name = element("td");
  name.append(element("strong", account.username), element("div", `Joined ${when(account.createdAt)}`, "muted"));
  if (account.scopes.length === 0) name.append(element("div", "No access", "no-access"));
  const save = element("button", "Save", "primary");
  const changed = () => granted.size !== account.scopes.length || account.scopes.some((scope) => !granted.has(scope));
  const sync = () => {
    save.disabled = !changed();
    if (changed()) drafts.set(account.username, [...granted]);
    else drafts.delete(account.username);
  };
  const cells = scopes.map((scope) => {
    const cell = element("td", undefined, "scope-cell");
    const box = element("input");
    box.type = "checkbox";
    box.checked = granted.has(scope.id);
    box.setAttribute("aria-label", `${account.username} can open ${scope.name}`);
    box.addEventListener("change", () => {
      if (box.checked) granted.add(scope.id);
      else granted.delete(scope.id);
      sync();
    });
    cell.append(box);
    return cell;
  });
  save.setAttribute("aria-label", `Save permissions for ${account.username}`);
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(account.username)}/scopes`, "PUT", {
        scopes: scopes.map((scope) => scope.id).filter((id) => granted.has(id)),
      });
      drafts.delete(account.username);
      notify(`Saved permissions for ${account.username}.`, true);
      await load();
    } catch (reason) {
      notify(reason.message);
      sync();
    }
  });
  const remove = element("button", "Delete", "danger");
  remove.setAttribute("aria-label", `Delete account ${account.username}`);
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete ${account.username}? They are signed out everywhere and can't sign in again.`)) return;
    remove.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(account.username)}`, "DELETE");
      drafts.delete(account.username);
      notify(`Deleted ${account.username}.`, true);
      await load();
    } catch (reason) {
      notify(reason.message);
      remove.disabled = false;
    }
  });
  const actions = element("td");
  const buttons = element("div", undefined, "row-actions");
  buttons.append(save, remove);
  actions.append(buttons);
  tr.append(name, ...cells, actions);
  sync();
  return tr;
}

async function load() {
  const { accounts, scopes } = await api("/api/accounts");
  heading(scopes);
  $("account-rows").replaceChildren(...accounts.map((account) => row(account, scopes)));
  $("accounts-empty").hidden = accounts.length > 0;
}

ownerPage(load)();

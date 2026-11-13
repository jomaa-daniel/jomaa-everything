import { $, api, ApiError, element, notify, ownerPage } from "/home/accounts.js";

/** The latest listing: files with masked keys, and whether redeploys are available. Null until loaded. */
let listing = null;
/** Unsaved edits per file: key -> { value } or { delete: true }. */
const pending = new Map();
/** Values revealed since the last load, by file then key. Kept only in memory. */
const revealed = new Map();
/** The key being edited, as "file\nkey". */
let editing = null;
let pollTimer = null;
let runActive = false;

function changesFor(file) {
  if (!pending.has(file)) pending.set(file, new Map());
  return pending.get(file);
}

function revealedFor(file) {
  if (!revealed.has(file)) revealed.set(file, new Map());
  return revealed.get(file);
}

/** Asks for the hub password in a dialog; resolves to it, or null when cancelled. */
function askPassword(title) {
  const dialog = $("confirm");
  $("confirm-title").textContent = title;
  $("confirm-password").value = "";
  return new Promise((resolve) => {
    const finish = (value) => {
      $("confirm-password").value = "";
      if (dialog.open) dialog.close();
      resolve(value);
    };
    $("confirm-form").onsubmit = (event) => {
      event.preventDefault();
      finish($("confirm-password").value);
    };
    $("confirm-cancel").onclick = () => finish(null);
    dialog.oncancel = () => finish(null);
    dialog.showModal();
  });
}

function button(text, label, className, onClick) {
  const node = element("button", text, className);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.addEventListener("click", onClick);
  return node;
}

async function reveal(file, key) {
  const password = await askPassword(`Reveal ${key}`);
  if (password === null) return;
  try {
    const { value } = await api("/api/secrets/reveal", "POST", { file, key, password });
    revealedFor(file).set(key, value);
    notify("");
    render();
  } catch (reason) {
    notify(reason.message);
  }
}

function editor(file, key) {
  const input = element("input");
  input.setAttribute("aria-label", `New value for ${key} in ${file}`);
  const change = changesFor(file).get(key);
  input.value = change && "value" in change ? change.value : (revealedFor(file).get(key) ?? "");
  const keep = () => {
    changesFor(file).set(key, { value: input.value });
    editing = null;
    render();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") keep();
    if (event.key === "Escape") {
      editing = null;
      render();
    }
  });
  queueMicrotask(() => input.focus());
  return [
    input,
    button("Keep", `Keep the new value for ${key}`, "primary", keep),
    button("Cancel", `Cancel editing ${key}`, "", () => {
      editing = null;
      render();
    }),
  ];
}

function row(file, key, summary) {
  const li = element("li");
  const changes = changesFor(file);
  const change = changes.get(key);
  li.append(element("span", key, "secret-key"));
  if (editing === `${file}\n${key}`) {
    li.append(...editor(file, key));
    return li;
  }
  const value = element("span", undefined, "secret-value");
  const shown = revealedFor(file).get(key);
  if (change?.delete) {
    li.className = "pending-delete";
    value.textContent = "Deleted when you save";
  } else if (change) {
    li.className = "pending";
    value.textContent = summary ? "Changed, not saved" : "Added, not saved";
  } else if (shown !== undefined) {
    value.classList.add("revealed");
    value.textContent = shown === "" ? "(empty)" : shown;
  } else {
    value.textContent = summary.hasValue ? summary.masked : "(empty)";
  }
  li.append(value);
  if (summary && !change) {
    li.append(
      shown === undefined
        ? button("Reveal", `Reveal ${key} in ${file}`, "", () => void reveal(file, key))
        : button("Hide", `Hide ${key} in ${file}`, "", () => {
            revealedFor(file).delete(key);
            render();
          }),
    );
  }
  if (!change?.delete) {
    li.append(
      button("Edit", `Edit ${key} in ${file}`, "", () => {
        editing = `${file}\n${key}`;
        render();
      }),
    );
  }
  li.append(
    change
      ? button("Undo", `Undo the change to ${key} in ${file}`, "", () => {
          changes.delete(key);
          render();
        })
      : button("Delete", `Delete ${key} from ${file}`, "danger", () => {
          changes.set(key, { delete: true });
          render();
        }),
  );
  return li;
}

function addForm(file) {
  const form = element("form", undefined, "create-form");
  const key = element("input");
  key.placeholder = "NEW_KEY";
  key.required = true;
  key.pattern = "[A-Z][A-Z0-9_]*";
  key.title = "Capital letters, digits and underscores, starting with a letter";
  key.setAttribute("aria-label", `New key for ${file}`);
  const value = element("input");
  value.placeholder = "Value";
  value.setAttribute("aria-label", `Value of the new key for ${file}`);
  const add = element("button", "Add key");
  add.setAttribute("aria-label", `Add a key to ${file}`);
  form.append(key, value, add);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = key.value.trim();
    const summary = listing.files.find((candidate) => candidate.file === file);
    if (summary.keys.some((existing) => existing.key === name) || changesFor(file).has(name)) {
      notify(`${name} is already in ${file}; use Edit.`);
      return;
    }
    changesFor(file).set(name, { value: value.value });
    notify("");
    render();
  });
  return form;
}

async function save(file) {
  const changes = [...changesFor(file)].map(([key, change]) => ({ key, ...change }));
  const password = await askPassword(`Save ${changes.length} change${changes.length === 1 ? "" : "s"} to ${file}`);
  if (password === null) return;
  try {
    await api("/api/secrets", "PUT", { file, changes, password });
    pending.delete(file);
    notify(`Saved ${file}. Redeploy to apply the changes.`, true);
    $("redeploy").hidden = false;
    await load();
  } catch (reason) {
    notify(reason.message);
  }
}

function section(summary) {
  const wrap = element("section", undefined, "secret-file");
  wrap.append(element("h2", summary.file));
  if (!summary.exists) {
    wrap.append(element("p", "This file does not exist on the server.", "muted"));
    return wrap;
  }
  const changes = changesFor(summary.file);
  const added = [...changes.keys()].filter((key) => !summary.keys.some((existing) => existing.key === key));
  const list = element("ul", undefined, "management-list");
  list.append(
    ...summary.keys.map((key) => row(summary.file, key.key, key)),
    ...added.map((key) => row(summary.file, key, null)),
  );
  if (summary.keys.length === 0 && added.length === 0) wrap.append(element("p", "No keys yet.", "muted"));
  const actions = element("div", undefined, "actions");
  const count = changes.size;
  const saveButton = button(
    count === 0 ? "Save" : `Save ${count} change${count === 1 ? "" : "s"}`,
    `Save changes to ${summary.file}`,
    "primary",
    () => void save(summary.file),
  );
  saveButton.disabled = count === 0;
  actions.append(saveButton);
  if (count > 0) {
    actions.append(
      button("Discard changes", `Discard changes to ${summary.file}`, "", () => {
        pending.delete(summary.file);
        render();
      }),
    );
  }
  wrap.append(list, addForm(summary.file), actions);
  return wrap;
}

function render() {
  if (listing === null) return;
  $("files").replaceChildren(...listing.files.map(section));
  $("redeploy-button").disabled = !listing.redeploy.available || runActive;
  $("redeploy-help").hidden = listing.redeploy.available;
  $("token-file").textContent = listing.redeploy.tokenFile;
}

async function load() {
  listing = await api("/api/secrets");
  revealed.clear();
  editing = null;
  render();
}

function runStatus(text, outcome = "") {
  $("run-status").textContent = text;
  $("run-status").className = outcome;
}

/**
 * Follows a run until its attempt completes. The hub restarts during the
 * deploy, so failed requests are reported and polling continues.
 */
function follow(run) {
  clearTimeout(pollTimer);
  runActive = true;
  render();
  const tick = async () => {
    try {
      const now = await api(`/api/secrets/redeploy/${run.id}`);
      if (now.attempt >= run.attempt && now.status === "completed") {
        runActive = false;
        runStatus(
          now.conclusion === "success" ? "The deploy finished." : `The deploy finished: ${now.conclusion}.`,
          now.conclusion === "success" ? "success" : "failure",
        );
        render();
        return;
      }
      runStatus(now.attempt < run.attempt ? "Waiting for GitHub to start the run…" : `The deploy is ${now.status}…`);
    } catch (reason) {
      runStatus(
        reason instanceof ApiError && reason.status === 401
          ? "Sign in again to keep following the deploy."
          : "Waiting for the hub to come back; it restarts during the deploy…",
      );
    }
    pollTimer = setTimeout(tick, listing.redeploy.pollSeconds * 1000);
  };
  void tick();
}

$("redeploy-button").addEventListener("click", async () => {
  const password = await askPassword("Redeploy now");
  if (password === null) return;
  $("redeploy-button").disabled = true;
  try {
    const run = await api("/api/secrets/redeploy", "POST", { password });
    $("run-link").href = run.url;
    $("run-link").hidden = false;
    notify("");
    follow(run);
  } catch (reason) {
    notify(reason.message);
    render();
  }
});

ownerPage(load)();

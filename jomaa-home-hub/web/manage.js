import { sessionEndEvent, updateUIHints } from "/home/ui.js";
import { loadHealth, resetHealth, closeHealth, selectHealth } from "/manage/health.js";
const $ = (id) => document.getElementById(id);
const tabs = ["devices", "types", "groups", "health"];
const sourceLabels = { matter: "Matter", govee: "Govee", health: "Health reporter" };
let catalog = { types: [], groups: [], devices: [] };
let generation = 0;
let activeTab = location.hash === "#health" ? "health" : "devices";
let searchQuery = "";
let selectedKey = null;
let editorOpen = false;
let editingKey = null;
let pending = false;
let catalogStale = false;
const drafts = new Map();
let canManage = false;
let canHealth = false;
const healthStates = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notice(text, state = "") {
  $("notice").textContent = text;
  $("notice").className = state;
}

function updateCommands() {
  if (activeTab === "health") {
    updateUIHints();
    return;
  }
  const target = document.activeElement;
  let commands;
  if (target.closest(".tabs")) {
    commands = [
      ["←→", "Tabs"],
      ["Tab", "Panel"],
      ["/", "Search"],
    ];
    if (activeTab === "devices" && selectedKey) commands.splice(1, 0, ["↓", "Devices"]);
  } else if (target === $("device-search")) {
    commands = [
      ["↓", "Select"],
      ["Esc", searchQuery ? "Clear search" : "Devices"],
      ["Tab", "Next"],
    ];
  } else if (target.closest("#device-editor")) {
    commands =
      target.type === "checkbox"
        ? [["Space", "Toggle group"]]
        : target === $("assigned-type")
          ? [["↑↓", "Category"]]
          : [["Enter", "Activate"]];
    commands.push(["Tab", "Next"], ["Esc", "Devices"]);
  } else if (target.closest(".editing")) {
    commands = [
      ["Enter", target.tagName === "INPUT" ? "Save" : "Activate"],
      ["Esc", "Cancel"],
      ["Tab", "Actions"],
    ];
  } else if (target.closest(".create-form")) {
    commands = [
      ["Enter", activeTab === "types" ? "Add type" : "Add group"],
      ["Tab", "Next"],
    ];
  } else if (activeTab === "devices") {
    commands = [
      ["↑↓", "Select"],
      ["Enter", "Edit"],
      ["Tab", "Assignments"],
      ["/", "Search"],
    ];
  } else {
    commands = [
      ["Enter", "Activate"],
      ["Tab", "Next"],
      ["/", "Devices"],
    ];
  }
  const hints = $("command-hints");
  hints.replaceChildren();
  for (const [key, label] of commands) {
    const command = element("span", undefined, "key-command");
    command.append(element("kbd", key), element("span", label));
    hints.append(command);
  }
}

function signedIn(value) {
  $("login-section").hidden = value;
  for (const id of ["management", "logout", "refresh", "command-hints"]) $(id).hidden = !value;
  if (!value) {
    resetHealth();
    generation++;
    catalog = { types: [], groups: [], devices: [] };
    drafts.clear();
    editingKey = selectedKey = null;
    editorOpen = pending = catalogStale = false;
    searchQuery = "";
    $("device-search").value = "";
    showTab(location.hash === "#health" ? "health" : "devices");
  }
}

async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json();
  if (response.status === 401 || response.status === 403) {
    signedIn(false);
    notice("Session ended. Sign in to continue.", "error");
  }
  if (!response.ok) throw Object.assign(new Error(body.error || "Request failed"), { status: response.status });
  return body;
}

function error(reason) {
  notice(reason.message || "Request failed", "error");
}

function setBusy() {
  $("editor-fields").disabled = pending || catalogStale;
  $("refresh").disabled = pending;
  for (const container of ["type-create", "group-create", "type-list", "group-list"]) {
    for (const control of $(container).querySelectorAll("input, button")) control.disabled = pending || catalogStale;
  }
  updateCommands();
}

function restoreFocus(id) {
  const control = id && $(id);
  if (control && !control.closest("[hidden]") && !control.disabled) control.focus({ preventScroll: true });
}

async function load() {
  const current = generation;
  const focused = document.activeElement?.id;
  const session = await api("/api/session");
  canManage = session.owner || session.scopes.includes("manage");
  canHealth = session.owner || session.scopes.includes("devices");
  for (const tab of tabs) $(tab + "-tab").hidden = tab === "health" ? !canHealth : !canManage;
  if (!canManage && !canHealth) {
    signedIn(false);
    throw new Error("Your account has no device access. Ask the hub owner to grant it.");
  }
  const result = canManage ? await api("/api/manage") : { types: [], groups: [], devices: [] };
  if (current !== generation) return;
  catalog = result;
  catalogStale = false;
  signedIn(true);
  if (canHealth) await loadHealth();
  render();
  showTab(canManage ? (activeTab === "health" && !canHealth ? "devices" : activeTab) : "health");
  restoreFocus(focused);
}

async function update(data) {
  if (pending || catalogStale) return false;
  const current = generation;
  const focused = document.activeElement?.id;
  pending = true;
  setBusy();
  notice("Saving…");
  try {
    await api("/api/manage", data);
    if (current !== generation) return false;
    if (data.action.endsWith(".rename") || data.action.endsWith(".delete")) {
      drafts.delete(editingKey);
      editingKey = null;
    }
    try {
      await load();
    } catch (reason) {
      if (current !== generation) return false;
      catalogStale = true;
      error(new Error(`Changes saved, but refresh failed. Refresh to continue editing. ${reason.message}`));
      return true;
    }
    if (current !== generation) return false;
    notice("Changes saved.", "success");
    return true;
  } catch (reason) {
    if (current === generation) {
      error(reason);
      renderDevices();
    }
    return false;
  } finally {
    if (current === generation) {
      pending = false;
      setBusy();
      const renamed = data.id && `${data.action.split(".")[0]}:${data.id}:rename`;
      if (document.activeElement === document.body || document.activeElement?.id === focused) {
        restoreFocus($(focused) ? focused : renamed || `${selectedKey}:select`);
      }
    }
  }
}

function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function showTab(tab, focus = false) {
  const refreshDevices = activeTab === "health" && tab === "devices" && canManage && !$("management").hidden;
  if (tab !== "health") closeHealth();
  activeTab = tab;
  for (const name of tabs) {
    const button = $(name + "-tab");
    button.setAttribute("aria-selected", String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
    $(name + "-panel").hidden = name !== tab;
  }
  updateCommands();
  if (focus) $(tab + "-tab").focus();
  if (tab === "health" && canHealth && !$("management").hidden) loadHealth().catch(error);
  if (refreshDevices) refreshCatalog().catch(error);
}

async function refreshCatalog() {
  const current = generation;
  const result = await api("/api/manage");
  if (current !== generation) return;
  const focused = document.activeElement?.id;
  catalog = result;
  render();
  restoreFocus(focused);
}

function renderList(kind, values) {
  const list = $(kind + "-list");
  list.replaceChildren();
  for (const item of values) {
    const key = `${kind}:${item.id}`;
    const usedBy = catalog.devices.filter((device) =>
      kind === "type" ? device.typeId === item.id : device.groupIds.includes(item.id),
    ).length;
    const row = element("li");
    const actions = element("div", undefined, "row-actions");
    if (kind === "type") {
      const swatch = element("span", undefined, "type-swatch");
      swatch.style.setProperty("--type-hue", item.hue);
      row.append(swatch);
    }
    if (editingKey === key) {
      row.classList.add("editing");
      const input = element("input");
      input.id = key + ":name";
      input.value = drafts.get(key) ?? item.name;
      input.maxLength = 80;
      input.setAttribute("aria-label", `Rename ${kind} ${item.name}`);
      input.addEventListener("input", () => drafts.set(key, input.value));
      const save = element("button", "Save", "primary");
      save.id = key + ":save";
      save.setAttribute("aria-label", `Save ${kind} ${item.name}`);
      save.addEventListener("click", () => update({ action: kind + ".rename", id: item.id, name: input.value }));
      const cancel = element("button", "Cancel", "quiet");
      cancel.id = key + ":cancel";
      cancel.addEventListener("click", cancelRename);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save.click();
        }
      });
      row.append(input);
      actions.append(save, cancel);
    } else {
      row.append(element("span", item.name, "item-name"), element("span", plural(usedBy, "device"), "item-meta"));
      const rename = element("button", "Rename", "quiet");
      rename.id = key + ":rename";
      rename.setAttribute("aria-label", `Rename ${kind} ${item.name}`);
      rename.addEventListener("click", () => {
        drafts.delete(editingKey);
        editingKey = key;
        renderList(kind, values);
        setBusy();
        $(key + ":name").focus();
        $(key + ":name").select();
      });
      const remove = element("button", "Delete", "quiet danger");
      remove.id = key + ":delete";
      remove.setAttribute("aria-label", `Delete ${kind} ${item.name}`);
      remove.addEventListener("click", () => {
        const consequence =
          kind === "group"
            ? "The room will be removed from Lights and parent groups. Devices will lose this group assignment."
            : "Devices will lose this type assignment and use their hardware type.";
        if (confirm(`Delete ${item.name}? ${consequence}`)) update({ action: kind + ".delete", id: item.id });
      });
      actions.append(rename, remove);
    }
    row.append(actions);
    list.append(row);
  }
  $(kind + "s-empty").hidden = values.length > 0;
}

function cancelRename() {
  if (pending || !editingKey) return;
  const key = editingKey;
  drafts.delete(key);
  editingKey = null;
  render();
  restoreFocus(key + ":rename");
}

function visibleDevices() {
  const query = searchQuery.toLowerCase();
  return catalog.devices.filter((device) => {
    const assigned = catalog.types.find((type) => type.id === device.typeId)?.name ?? "";
    const groups = catalog.groups
      .filter((group) => device.groupIds.includes(group.id))
      .map((group) => group.name)
      .join(" ");
    return `${device.name} ${device.source} ${device.reportedType} ${assigned} ${groups}`.toLowerCase().includes(query);
  });
}

function selectDevice(key, open = false) {
  selectedKey = key;
  editorOpen = open;
  renderDevices();
  if (open) {
    if (pending || catalogStale) $("selected-name").scrollIntoView({ block: "nearest" });
    else $("assigned-type").focus({ preventScroll: true });
  } else {
    restoreFocus(key + ":select");
    $(key + ":select")?.scrollIntoView({ block: "nearest" });
  }
}

function closeEditor() {
  editorOpen = false;
  $("device-workspace").classList.remove("editor-open");
  restoreFocus(selectedKey + ":select");
  $(selectedKey + ":select")?.scrollIntoView({ block: "nearest" });
}

function renderEditor() {
  const device = catalog.devices.find((device) => device.key === selectedKey);
  $("device-editor").hidden = !device;
  $("device-workspace").classList.toggle("editor-open", editorOpen && !!device);
  if (!device) return;
  $("selected-name").textContent = device.name;
  $("selected-source").textContent = sourceLabels[device.source] || device.source;
  $("health-open").hidden = !canHealth || (!device.key.startsWith("health:") && !device.key.startsWith("matter:"));
  $("reported-type").textContent = device.reportedType;
  const type = $("assigned-type");
  type.replaceChildren();
  const hardware = element("option", "Use hardware type");
  hardware.value = "";
  type.append(hardware);
  for (const value of catalog.types) {
    const option = element("option", value.name);
    option.value = value.id;
    type.append(option);
  }
  type.value = device.typeId || "";
  const groups = $("assigned-groups");
  groups.replaceChildren();
  for (const group of catalog.groups) {
    const label = element("label", undefined, "group-option");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.id = device.key + ":group:" + group.id;
    checkbox.value = group.id;
    checkbox.checked = device.groupIds.includes(group.id);
    checkbox.addEventListener("change", saveAssignment);
    label.append(checkbox, element("span", group.name));
    groups.append(label);
  }
  if (!catalog.groups.length) {
    const create = element("button", "+ Create a group", "quiet");
    create.addEventListener("click", () => {
      showTab("groups");
      $("group-name").focus();
    });
    groups.append(create);
  }
  setBusy();
}

function renderDevices() {
  const visible = visibleDevices();
  if (!visible.some((device) => device.key === selectedKey)) {
    selectedKey = visible[0]?.key ?? null;
    editorOpen = false;
  }
  $("visible-count").textContent = searchQuery
    ? `${visible.length} of ${plural(catalog.devices.length, "device")}`
    : plural(catalog.devices.length, "device");
  $("selection-position").textContent = selectedKey
    ? `${visible.findIndex((device) => device.key === selectedKey) + 1} / ${visible.length}`
    : "";
  const rows = $("assignment-rows");
  rows.replaceChildren();
  for (const device of visible) {
    const row = element("tr");
    row.classList.toggle("selected", device.key === selectedKey);
    const name = element("td");
    const select = element("button", undefined, "device-select");
    select.id = device.key + ":select";
    select.tabIndex = device.key === selectedKey ? 0 : -1;
    select.setAttribute("aria-pressed", String(device.key === selectedKey));
    select.setAttribute("aria-label", `Edit ${device.name}`);
    select.append(
      element("span", device.name),
      element("span", sourceLabels[device.source] || device.source, "device-source"),
    );
    select.addEventListener("click", () => selectDevice(device.key, true));
    select.addEventListener("keydown", (event) => {
      const index = visible.findIndex((entry) => entry.key === device.key);
      let next = index;
      if (event.key === "ArrowDown") next = Math.min(index + 1, visible.length - 1);
      else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = visible.length - 1;
      else return;
      event.preventDefault();
      selectDevice(visible[next].key);
    });
    row.addEventListener("click", (event) => {
      if (!event.target.closest("button")) selectDevice(device.key, true);
    });
    name.append(select);
    const category = element("td");
    const assigned = catalog.types.find((type) => type.id === device.typeId);
    const categoryName = element("span", undefined, "category-name");
    if (assigned) {
      const swatch = element("span", undefined, "type-swatch");
      swatch.style.setProperty("--type-hue", assigned.hue);
      categoryName.append(swatch);
    }
    categoryName.append(element("span", assigned?.name || device.reportedType));
    category.append(categoryName);
    const groups = catalog.groups.filter((group) => device.groupIds.includes(group.id)).map((group) => group.name);
    row.append(name, category, element("td", groups.join(", ") || "—", groups.length ? undefined : "unassigned"));
    const state = healthStates.get(device.key);
    row.append(element("td", state || "Not reported", state ? "health-state " + state : "unassigned"));
    rows.append(row);
  }
  $("assignment-table-wrap").hidden = !visible.length;
  $("devices-empty").hidden = !!catalog.devices.length;
  $("devices-no-match").hidden = !(catalog.devices.length && !visible.length);
  $("matter-unavailable").hidden = catalog.matterConnected !== false;
  renderEditor();
}

function render() {
  $("device-count").textContent = catalog.devices.length;
  $("type-count").textContent = catalog.types.length;
  $("group-count").textContent = catalog.groups.length;
  renderList("type", catalog.types);
  renderList("group", catalog.groups);
  renderDevices();
  setBusy();
}

async function saveAssignment() {
  const device = catalog.devices.find((device) => device.key === selectedKey);
  if (!device || pending || catalogStale) return;
  const data = { action: "device.assign", key: device.key };
  const typeId = $("assigned-type").value || null;
  const groupIds = [...$("assigned-groups").querySelectorAll("input:checked")].map((input) => input.value);
  if (typeId !== device.typeId) data.typeId = typeId;
  if (JSON.stringify([...groupIds].sort()) !== JSON.stringify([...device.groupIds].sort())) data.groupIds = groupIds;
  if (data.typeId === undefined && data.groupIds === undefined) return;
  await update(data);
}

$("assigned-type").addEventListener("change", saveAssignment);
$("health-open").addEventListener("click", () => {
  const key = selectedKey;
  showTab("health", true);
  selectHealth(key).catch(error);
});
document.addEventListener(sessionEndEvent, () => signedIn(false));
document.addEventListener("health-data", (event) => {
  healthStates.clear();
  for (const device of event.detail.devices) healthStates.set("health:" + device.id, device.status);
  for (const device of event.detail.matterNodes)
    healthStates.set("matter:" + device.nodeId, device.available ? "online" : "offline");
  $("health-count").textContent = event.detail.devices.length + event.detail.matterNodes.length;
  if (canManage) renderDevices();
});
document.addEventListener("focusin", updateCommands);
$("editor-back").addEventListener("click", closeEditor);
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const username = $("username").value.trim();
  button.disabled = true;
  try {
    await api("/api/login", { password: $("password").value, ...(username ? { username } : {}) });
    await load();
    notice("Ready.");
    $(activeTab + "-tab").focus();
  } catch (reason) {
    error(reason);
  } finally {
    $("password").value = "";
    button.disabled = false;
  }
});
$("logout").addEventListener("click", async () => {
  try {
    generation++;
    pending = true;
    setBusy();
    await api("/api/logout", {});
    signedIn(false);
    notice("Sign in to organize your devices.");
    $("password").focus();
  } catch (reason) {
    error(reason);
  } finally {
    pending = false;
    setBusy();
  }
});
$("refresh").addEventListener("click", () =>
  load()
    .then(() => notice("Refreshed."))
    .catch(error),
);
$("device-search").addEventListener("input", (event) => {
  searchQuery = event.target.value.trim();
  editorOpen = false;
  renderDevices();
});
$("device-search").addEventListener("keydown", (event) => {
  if ((event.key === "ArrowDown" || event.key === "Enter") && selectedKey) {
    event.preventDefault();
    selectDevice(selectedKey);
  }
});
for (const tab of tabs) {
  $(tab + "-tab").addEventListener("click", () => showTab(tab));
  $(tab + "-tab").addEventListener("keydown", (event) => {
    const available = tabs.filter((name) => !$(name + "-tab").hidden);
    let index = available.indexOf(tab);
    if (event.key === "ArrowRight") index = (index + 1) % available.length;
    else if (event.key === "ArrowLeft") index = (index + available.length - 1) % available.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = available.length - 1;
    else return;
    event.preventDefault();
    showTab(available[index], true);
  });
}
document.addEventListener("keydown", (event) => {
  if ($("management").hidden || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (event.key === "Escape") {
    if (editingKey && activeTab === editingKey.split(":")[0] + "s") cancelRename();
    else if (target === $("device-search") && searchQuery) {
      searchQuery = $("device-search").value = "";
      renderDevices();
    } else if (activeTab === "devices") closeEditor();
    return;
  }
  if (
    event.key === "ArrowDown" &&
    activeTab === "devices" &&
    selectedKey &&
    (target === $("devices-tab") || target === document.body)
  ) {
    event.preventDefault();
    selectDevice(selectedKey);
    return;
  }
  if (event.key !== "/" || target.matches("input, select, textarea") || target.isContentEditable) return;
  event.preventDefault();
  showTab("devices");
  closeEditor();
  $("device-search").focus();
});
for (const kind of ["type", "group"]) {
  $(kind + "-create").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (await update({ action: kind + ".create", name: $(kind + "-name").value })) {
      $(kind + "-name").value = "";
      $(kind + "-name").focus();
    }
  });
}
load()
  .then(() => notice("Ready."))
  .catch((reason) => {
    if (reason.status === 401) notice("Sign in to organize your devices.");
    else error(reason);
  });

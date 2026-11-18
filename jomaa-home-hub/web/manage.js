import { sessionEndEvent, updateUIHints } from "/home/ui.js";
import { loadHealth, resetHealth, closeHealth, selectHealth } from "/manage/health.js";
import { PicoPanel } from "/manage/picos.js";
const $ = (id) => document.getElementById(id);
const picoPanel = new PicoPanel(() => signedIn(false));
const tabs = ["devices", "types", "groups", "imaging"];
const requestedTab = () => (tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : "devices");
const sourceLabels = { matter: "Matter", govee: "Govee", health: "Health reporter" };
let catalog = { types: [], groups: [], devices: [] };
let generation = 0;
let activeTab = requestedTab();
let searchQuery = "";
let selectedKey = null;
let renamingKey = null;
let editorOpen = false;
let editingKey = null;
let pending = false;
let catalogStale = false;
const drafts = new Map();
const deviceDrafts = new Map();
let canManage = false;
let canHealth = false;
const healthStates = new Map();
const statusDetails = new Map();
const inventoryFilters = { capability: null, group: null, status: null };
const emptyFilter = "";

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
  if (document.activeElement.closest("#pico-panel")) {
    updateUIHints();
    return;
  }
  if (activeTab === "imaging") {
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
  } else if (target.closest("#inventory-filters")) {
    commands = [
      ["↑↓", "Filter"],
      ["Tab", "Next"],
    ];
  } else if (target.closest("#device-editor")) {
    commands =
      target.type === "checkbox"
        ? [["Space", "Toggle group"]]
        : target.matches("input") || target === $("save-device-name")
          ? [["Enter", "Save"]]
          : target === $("edit-device-name")
            ? [["Enter", "Rename"]]
            : [["Enter", "Activate"]];
    commands.push(
      ["Tab", "Next"],
      ["Esc", renamingKey === selectedKey && target.closest("#device-rename") ? "Cancel" : "Devices"],
    );
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
      ["Enter", "Details"],
      ["Tab", "Details"],
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
  picoPanel.session(value && canHealth);
  $("login-section").hidden = value;
  for (const id of ["management", "logout", "refresh", "command-hints"]) $(id).hidden = !value;
  if (!value) {
    resetHealth();
    generation++;
    catalog = { types: [], groups: [], devices: [] };
    drafts.clear();
    deviceDrafts.clear();
    renamingKey = null;
    for (const key of Object.keys(inventoryFilters)) inventoryFilters[key] = null;
    healthStates.clear();
    statusDetails.clear();
    editingKey = selectedKey = null;
    editorOpen = pending = catalogStale = false;
    searchQuery = "";
    $("device-search").value = "";
    showTab(requestedTab());
  }
}

async function api(path, data, method = "POST") {
  const response = await fetch(path, {
    method: data === undefined ? "GET" : method,
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
  $("device-name").disabled = pending || catalogStale;
  $("save-device-name").disabled = pending || catalogStale;
  $("edit-device-name").disabled = pending || catalogStale;
  $("detail-refresh").disabled = pending;
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

async function load(refreshHistory = false) {
  const current = generation;
  const focused = document.activeElement?.id;
  const session = await api("/api/session");
  canManage = session.owner || session.scopes.includes("manage");
  canHealth = session.owner || session.scopes.includes("devices");
  for (const tab of tabs)
    $(tab + "-tab").hidden = tab === "devices" ? false : tab === "imaging" ? !canHealth : !canManage;
  if (!canManage && !canHealth) {
    signedIn(false);
    throw new Error("Your account has no device access. Ask the hub owner to grant it.");
  }
  const result = canManage ? await api("/api/manage") : { ...catalog, types: [] };
  if (canManage)
    result.devices = result.devices.map((device) => ({
      ...device,
      groups: result.groups.filter((group) => device.groupIds.includes(group.id)).map((group) => group.name),
      assignedType: result.types.find((type) => type.id === device.typeId) ?? null,
    }));
  if (current !== generation) return;
  catalog = result;
  catalogStale = false;
  signedIn(true);
  render();
  if (canHealth) await loadHealth(refreshHistory);
  else resetHealth();
  render();
  showTab($(activeTab + "-tab").hidden ? "devices" : activeTab);
  restoreFocus(focused);
}

async function update(data, path = "/api/manage", method = "POST") {
  if (pending || catalogStale) return false;
  const current = generation;
  const focused = document.activeElement?.id;
  pending = true;
  setBusy();
  notice("Saving…");
  try {
    await api(path, data, method);
    if (current !== generation) return false;
    if (data.action?.endsWith(".rename") || data.action?.endsWith(".delete")) {
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
      const renamed = data.id && data.action && `${data.action.split(".")[0]}:${data.id}:rename`;
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
  if (tab !== "devices") closeHealth();
  activeTab = tab;
  if (!$("management").hidden) history.replaceState(null, "", "#" + tab);
  for (const name of tabs) {
    const button = $(name + "-tab");
    button.setAttribute("aria-selected", String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
    $(name + "-panel").hidden = name !== tab;
  }
  updateCommands();
  if (focus) $(tab + "-tab").focus();
  if (tab === "devices" && canHealth && !$("management").hidden) selectHealth(selectedKey);
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
    const assigned = device.assignedType?.name ?? "";
    const groups = deviceGroups(device);
    const capabilities = device.capabilities;
    return (
      `${device.name} ${device.key} ${device.source} ${device.reportedType} ${assigned} ${groups.join(" ")} ${capabilities.join(" ")}`
        .toLowerCase()
        .includes(query) &&
      (inventoryFilters.capability === null ||
        (capabilities.length ? capabilities : [emptyFilter]).includes(inventoryFilters.capability)) &&
      (inventoryFilters.group === null || (groups.length ? groups : [emptyFilter]).includes(inventoryFilters.group)) &&
      (inventoryFilters.status === null || healthStates.get(device.key) === inventoryFilters.status)
    );
  });
}

function deviceGroups(device) {
  return device.groups;
}

function renderFilters() {
  const choices = {
    capability: catalog.devices.flatMap((device) => (device.capabilities.length ? device.capabilities : [emptyFilter])),
    group: catalog.devices.flatMap((device) => (deviceGroups(device).length ? deviceGroups(device) : [emptyFilter])),
    status: [...healthStates.values()],
  };
  for (const key of Object.keys(inventoryFilters)) {
    const select = $(key + "-filter");
    const values = [null, ...[...new Set(choices[key])].sort()];
    if (!values.includes(inventoryFilters[key])) values.push(inventoryFilters[key]);
    const serialized = JSON.stringify(values);
    if (select.dataset.choices !== serialized) {
      select.replaceChildren();
      for (const value of values) {
        const option = element(
          "option",
          value === null ? "All" : value === emptyFilter ? (key === "group" ? "No group" : "Not reported") : value,
        );
        option.value = JSON.stringify(value);
        select.append(option);
      }
      select.dataset.choices = serialized;
    }
    select.value = JSON.stringify(inventoryFilters[key]);
  }
  $("status-filter-field").hidden = !canHealth;
  $("clear-filters").hidden = Object.values(inventoryFilters).every((value) => value === null);
  const counts = new Map();
  for (const state of healthStates.values()) counts.set(state, (counts.get(state) || 0) + 1);
  $("device-summary").hidden = !canHealth || !counts.size;
  $("device-summary").textContent = [...counts].map(([state, count]) => `${count} ${state}`).join(" · ");
}

function selectDevice(key, open = false) {
  if (key !== selectedKey) {
    deviceDrafts.delete(renamingKey);
    renamingKey = null;
  }
  selectedKey = key;
  editorOpen = open;
  renderDevices();
  if (open) {
    if (pending || catalogStale) $("selected-name").scrollIntoView({ block: "nearest" });
    else
      (renamingKey === key
        ? $("device-name")
        : $("edit-device-name").hidden
          ? $("selected-name")
          : $("edit-device-name")
      ).focus({ preventScroll: true });
  } else {
    restoreFocus(key + ":select");
    $(key + ":select")?.scrollIntoView({ block: "nearest" });
  }
}

function closeEditor() {
  deviceDrafts.delete(renamingKey);
  renamingKey = null;
  renderEditor();
  editorOpen = false;
  closeHealth();
  $("device-workspace").classList.remove("editor-open");
  restoreFocus(selectedKey + ":select");
  $(selectedKey + ":select")?.scrollIntoView({ block: "nearest" });
}

function renderEditor() {
  const device = catalog.devices.find((device) => device.key === selectedKey);
  $("device-editor").hidden = !device;
  $("device-workspace").classList.toggle("editor-open", editorOpen && !!device);
  if (!device) {
    selectHealth(null);
    return;
  }
  $("selected-name").textContent = device.name;
  $("selected-source").textContent = sourceLabels[device.source] || device.source;
  const canRename = canHealth || (canManage && device.source === "govee");
  const editingName = renamingKey === device.key && canRename;
  $("selected-name").hidden = editingName;
  $("device-name").hidden = !editingName;
  $("device-name").required = editingName;
  $("edit-device-name").hidden = !canRename || editingName;
  $("edit-device-name").setAttribute("aria-expanded", String(editingName));
  $("save-device-name").hidden = !editingName;
  $("detail-refresh").hidden = !canHealth;
  $("device-name").value = deviceDrafts.get(device.key) ?? device.name;
  $("editor-fields").hidden = !canManage;
  $("matter-group-form").hidden = canManage;
  if (canHealth) selectHealth(device.key);
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
  renderFilters();
  const visible = visibleDevices();
  if (!visible.some((device) => device.key === selectedKey)) {
    deviceDrafts.delete(renamingKey);
    renamingKey = null;
    selectedKey = visible[0]?.key ?? null;
    editorOpen = false;
  }
  $("visible-count").textContent =
    searchQuery || Object.values(inventoryFilters).some((value) => value !== null)
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
    const groups = deviceGroups(device);
    row.append(name, category, element("td", groups.join(", ") || "—", groups.length ? undefined : "unassigned"));
    const state = healthStates.get(device.key);
    const stateCell = element(
      "td",
      state || (canHealth ? "Checking…" : "Health access required"),
      state ? "health-state " + state : "unassigned",
    );
    const details = statusDetails.get(device.key);
    if (details)
      stateCell.title = `${details.statusSource} · Checked ${new Date(details.checkedAt).toLocaleString()}${details.reason ? " · " + details.reason : ""}`;
    row.append(stateCell);
    rows.append(row);
  }
  $("assignment-table-wrap").hidden = !visible.length;
  $("devices-empty").hidden = !!catalog.devices.length;
  $("devices-no-match").hidden = !(catalog.devices.length && !visible.length);
  $("devices-no-match").textContent = "No matching devices.";
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
  const groupIds = [...$("assigned-groups").querySelectorAll("input:checked")].map((input) => input.value);
  if (JSON.stringify([...groupIds].sort()) !== JSON.stringify([...device.groupIds].sort())) data.groupIds = groupIds;
  if (data.groupIds === undefined) return;
  await update(data);
}

$("device-name").addEventListener("input", () => deviceDrafts.set(selectedKey, $("device-name").value));
$("edit-device-name").addEventListener("click", () => {
  if (pending || catalogStale || !selectedKey) return;
  renamingKey = selectedKey;
  renderEditor();
  $("device-name").focus();
  $("device-name").select();
});
$("device-rename").addEventListener("submit", async (event) => {
  event.preventDefault();
  const device = catalog.devices.find((device) => device.key === selectedKey);
  if (!device || renamingKey !== device.key) return;
  const name = $("device-name").value.trim();
  let saved;
  if (device.source === "govee") saved = await update({ action: "device.rename", key: device.key, name });
  else {
    const path =
      device.source === "matter"
        ? `/api/matter/nodes/${device.key.slice("matter:".length)}/name`
        : `/api/devices/${encodeURIComponent(device.key.slice("health:".length))}`;
    saved = await update({ name }, path, "PATCH");
  }
  if (saved) {
    deviceDrafts.delete(device.key);
    if (renamingKey === device.key) renamingKey = null;
    if (catalogStale) {
      const savedDevice = catalog.devices.find((entry) => entry.key === device.key);
      if (savedDevice) savedDevice.name = name;
    }
    renderEditor();
    restoreFocus("edit-device-name");
  }
});
document.addEventListener(sessionEndEvent, () => signedIn(false));
document.addEventListener("health-data", (event) => {
  const focused = document.activeElement?.id;
  healthStates.clear();
  statusDetails.clear();
  for (const device of event.detail.goveeDevices) {
    healthStates.set("target:" + device.id, device.status);
    statusDetails.set("target:" + device.id, device);
  }
  for (const device of event.detail.devices) healthStates.set("health:" + device.id, device.status);
  for (const device of event.detail.matterNodes)
    healthStates.set("matter:" + device.nodeId, device.available ? "online" : "offline");
  const inventory = [
    ...event.detail.goveeDevices.map((device) => ({
      ...device,
      key: "target:" + device.id,
      source: "govee",
      reportedType: device.type,
    })),
    ...event.detail.matterNodes.map((device) => ({
      ...device,
      key: "matter:" + device.nodeId,
      name: device.label || device.product || `Matter device ${device.nodeId}`,
      source: "matter",
      reportedType: device.type,
    })),
    ...event.detail.devices.map((device) => ({
      ...device,
      key: "health:" + device.id,
      source: "health",
      reportedType: "Health reporter",
      capabilities: ["Health reporting"],
    })),
  ].map((device) => ({ ...device, typeId: device.assignedType?.id ?? null }));
  catalog = {
    ...catalog,
    groups: event.detail.groups,
    devices: inventory,
    matterConnected: event.detail.matterConnected,
  };
  renderDevices();
  $("device-count").textContent = catalog.devices.length;
  restoreFocus(focused);
});
document.addEventListener("device-selected", (event) => selectDevice(event.detail, true));
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
    notice("Sign in to manage devices.");
    $("password").focus();
  } catch (reason) {
    error(reason);
  } finally {
    pending = false;
    setBusy();
  }
});
for (const id of ["refresh", "detail-refresh"])
  $(id).addEventListener("click", () =>
    load(true)
      .then(() => notice("Refreshed."))
      .catch(error),
  );
for (const key of Object.keys(inventoryFilters))
  $(key + "-filter").addEventListener("change", (event) => {
    inventoryFilters[key] = JSON.parse(event.target.value);
    editorOpen = false;
    renderDevices();
  });
$("clear-filters").addEventListener("click", () => {
  for (const key of Object.keys(inventoryFilters)) inventoryFilters[key] = null;
  renderDevices();
});
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
    else if (renamingKey && target.closest("#device-rename") && !pending) {
      deviceDrafts.delete(renamingKey);
      renamingKey = null;
      renderEditor();
      restoreFocus("edit-device-name");
    } else if (target === $("device-search") && searchQuery) {
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
    if (reason.status === 401) notice("Sign in to manage devices.");
    else error(reason);
  });

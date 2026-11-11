const $ = (id) => document.getElementById(id);
let devices = [];
let matterNodes = [];
let selected = null;
let selectedMatter = null;
let matterNameDirty = false;
let dirty = false;
let cursor = null;
let credential = null;
let refreshing = null;
let refreshGeneration = 0;
let inventoryGeneration = 0;
let refreshInventoryGeneration = 0;
let sessionGeneration = 0;
let showingOlder = false;
let scanController = null;
let scanTimer = null;
let scanGeneration = 0;
let pairingDevice = null;
let pairing = false;
const columnFilters = { type: null, capabilities: null, group: null };
const filterColumns = ["type", "capabilities", "group", "status"];
const chipColors = ["green", "amber", "violet", "blue", "rose", "teal"];
const capabilityColors = {
  Power: "green",
  Brightness: "amber",
  Color: "violet",
  "White temperature": "blue",
  "Health reporting": "teal",
};

function node(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
}

function chipColor(label) {
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return chipColors[hash % chipColors.length];
}

function chipCell(labels, kind, empty) {
  const cell = node("td");
  const list = node("div", undefined, "chip-list");
  if (!labels.length) list.append(node("span", empty, "chip chip-neutral"));
  for (const label of labels) {
    const color = kind === "capabilities" ? capabilityColors[label] || chipColor(label) : chipColor(label);
    list.append(node("span", label, `chip chip-${color}`));
  }
  cell.append(list);
  return cell;
}

function selectedColumn(column) {
  return column === "status" ? ($("filter").value === "all" ? null : $("filter").value) : columnFilters[column];
}

function columnChoices(column) {
  const values = [];
  for (const device of devices) {
    values.push(
      column === "type"
        ? "Health reporter"
        : column === "capabilities"
          ? "Health reporting"
          : column === "group"
            ? "No group"
            : device.status,
    );
  }
  for (const device of matterNodes) {
    if (column === "type") values.push(device.type);
    else if (column === "capabilities")
      values.push(...(device.capabilities.length ? device.capabilities : ["Not reported"]));
    else if (column === "group") values.push(...(device.groups.length ? device.groups : ["No group"]));
    else values.push(device.available ? "online" : "offline");
  }
  return [null, ...[...new Set(values)].sort((a, b) => a.localeCompare(b))];
}

function cycleColumn(column) {
  const choices = columnChoices(column);
  const next = choices[(choices.indexOf(selectedColumn(column)) + 1) % choices.length];
  if (column === "status") $("filter").value = next || "all";
  else columnFilters[column] = next;
  render();
}

function matchesColumns(type, capabilities, groups) {
  return (
    (columnFilters.type === null || columnFilters.type === type) &&
    (columnFilters.capabilities === null ||
      (capabilities.length ? capabilities : ["Not reported"]).includes(columnFilters.capabilities)) &&
    (columnFilters.group === null || (groups.length ? groups : ["No group"]).includes(columnFilters.group))
  );
}

function renderColumnFilters() {
  for (const column of filterColumns) {
    const value = selectedColumn(column);
    $("cycle-" + column).className = value === null ? "column-filter" : "column-filter filtered";
    $(column + "-filter-value").textContent = value === null ? "All" : value;
    $("cycle-" + column).setAttribute(
      "aria-label",
      `Cycle ${column} filter. Current: ${value === null ? "All" : value}`,
    );
  }
  $("clear-filters").hidden = !$("search").value && filterColumns.every((column) => selectedColumn(column) === null);
}

function signedIn(value) {
  $("login-section").hidden = value;
  for (const id of ["inventory", "add", "logout"]) $(id).hidden = !value;
  if (!value) {
    sessionGeneration += 1;
    selected = null;
    devices = [];
    matterNodes = [];
    selectedMatter = null;
    $("detail").hidden = true;
    $("matter-detail").hidden = true;
    $("discover-dialog").close();
    $("matter-pair-dialog").close();
    $("enroll-dialog").close();
    $("credential-dialog").close();
  }
}

async function api(path, method = "GET", data, signal) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (response.status === 401) signedIn(false);
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

function error(reason) {
  $("notice").className = "";
  $("notice").textContent = reason.message || "Request failed";
}
function duration(seconds) {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
function lastSeen(value) {
  return value === null ? "Never" : `${duration(Math.max(0, Math.floor((Date.now() - value) / 1000)))} ago`;
}
function stamp(value) {
  return value === null ? "Awaiting first report" : new Date(value).toLocaleString();
}
function status(value) {
  return node("span", value, `status ${value}`);
}

function render() {
  renderColumnFilters();
  const counts = devices.reduce((all, device) => {
    all[device.status] = (all[device.status] || 0) + 1;
    return all;
  }, {});
  for (const device of matterNodes) {
    const state = device.available ? "online" : "offline";
    counts[state] = (counts[state] || 0) + 1;
  }
  $("summary").textContent =
    `${devices.length + matterNodes.length} devices · ${counts.online || 0} online · ${counts.offline || 0} offline · ${counts.degraded || 0} degraded`;
  const search = $("search").value.toLowerCase();
  const filter = $("filter").value;
  const visible = devices.filter(
    (d) =>
      (filter === "all" || d.status === filter) &&
      matchesColumns("Health reporter", ["Health reporting"], []) &&
      `${d.name} ${d.id} Health reporter Health reporting No group`.toLowerCase().includes(search),
  );
  $("device-rows").replaceChildren();
  for (const device of visible) {
    const row = node("tr", undefined, device.id === selected ? "selected" : "");
    const cell = node("td");
    const button = node("button", device.name, "device-link");
    button.addEventListener("click", () => select(device.id));
    cell.append(button, node("span", device.id, "device-id"));
    const stateCell = node("td");
    stateCell.append(status(device.status));
    row.append(
      cell,
      node("td", "Health reporter"),
      chipCell(["Health reporting"], "capabilities", "Not reported"),
      chipCell([], "group", "No group"),
      stateCell,
      node("td", lastSeen(device.lastSeen)),
      node("td", duration(device.latest?.uptimeSeconds)),
      node("td", device.latest?.rssi === undefined ? "—" : `${device.latest.rssi} dBm`),
    );
    $("device-rows").append(row);
  }
  const visibleMatter = matterNodes.filter(
    (device) =>
      (filter === "all" || (device.available ? "online" : "offline") === filter) &&
      matchesColumns(device.type, device.capabilities, device.groups) &&
      `${matterName(device)} ${device.vendor || ""} ${device.nodeId} ${device.type} ${device.capabilities.join(" ")} ${device.groups.join(" ")}`
        .toLowerCase()
        .includes(search),
  );
  for (const device of visibleMatter) {
    const row = node("tr", undefined, device.nodeId === selectedMatter ? "selected" : "");
    const cell = node("td");
    const button = node("button", matterName(device), "device-link");
    button.addEventListener("click", () => selectMatter(device.nodeId));
    cell.append(button, node("span", `Matter · Node ${device.nodeId}`, "device-id"));
    const stateCell = node("td");
    stateCell.append(status(device.available ? "online" : "offline"));
    const uptimeCell = node("td", device.uptimeSeconds === null ? "Unavailable" : duration(device.uptimeSeconds));
    if (device.uptimeObservedAt !== null) uptimeCell.title = `Reported ${stamp(device.uptimeObservedAt)}`;
    row.append(
      cell,
      node("td", device.type),
      chipCell(device.capabilities, "capabilities", "Not reported"),
      chipCell(device.groups, "group", "No group"),
      stateCell,
      node("td", device.lastSeen === null ? "Not seen yet" : lastSeen(device.lastSeen)),
      uptimeCell,
      node("td", "—"),
    );
    $("device-rows").append(row);
  }
  $("empty").hidden = visible.length + visibleMatter.length > 0;
  $("empty").textContent =
    devices.length + matterNodes.length
      ? "No devices match your filters."
      : "No devices yet. Add a device to get started.";
  renderDetail();
  renderMatterDetail();
}

function matterName(device) {
  return device.label || device.product || `Matter device ${device.nodeId}`;
}

function renderMatterDetail() {
  const device = matterNodes.find((candidate) => candidate.nodeId === selectedMatter);
  $("matter-detail").hidden = !device;
  if (!device) return;
  $("matter-detail-title").textContent = matterName(device);
  $("matter-facts").replaceChildren();
  for (const [label, value] of [
    ["Matter node", device.nodeId],
    ["Connection", device.available ? "Connected" : "Offline"],
    ["Last seen", device.lastSeen === null ? "Not seen yet" : stamp(device.lastSeen)],
    ["Reported uptime", device.uptimeSeconds === null ? "Unavailable" : duration(device.uptimeSeconds)],
    ["Uptime reported", device.uptimeObservedAt === null ? "Unavailable" : stamp(device.uptimeObservedAt)],
    ["Manufacturer", device.vendor || "—"],
    ["Product", device.product || "—"],
    ["Bridge", device.isBridge ? "Yes" : "No"],
    ["Lights and plugs", device.lightEndpoints.length],
  ]) {
    const fact = node("div");
    fact.append(node("dt", label), node("dd", value));
    $("matter-facts").append(fact);
  }
  if (!matterNameDirty) $("matter-name").value = matterName(device);
}

function selectMatter(nodeId) {
  selected = null;
  selectedMatter = nodeId;
  matterNameDirty = false;
  render();
}

function renderDetail() {
  const device = devices.find((d) => d.id === selected);
  $("detail").hidden = !device;
  if (!device) return;
  $("detail-title").textContent = device.name;
  $("device-facts").replaceChildren();
  for (const [label, value] of [
    ["Device ID", device.id],
    ["Status", device.status],
    ["Firmware", device.latest?.firmware || "—"],
    ["IP address", device.latest?.ip || "—"],
    ["First report", stamp(device.registeredAt)],
    ["Last report", stamp(device.lastSeen)],
    ["Free heap", device.latest ? `${Math.round(device.latest.freeHeapBytes / 1024)} KB` : "—"],
    ["Report interval", `${device.intervalSeconds}s`],
  ]) {
    const fact = node("div");
    fact.append(node("dt", label), node("dd", value));
    $("device-facts").append(fact);
  }
  if (!dirty) {
    $("device-name").value = device.name;
    $("device-interval").value = device.intervalSeconds;
  }
  $("revoke").disabled = device.status === "revoked";
}

async function refresh() {
  if (refreshing && refreshGeneration === sessionGeneration && refreshInventoryGeneration === inventoryGeneration)
    return refreshing;
  const operation = refreshInventory();
  refreshing = operation;
  refreshGeneration = sessionGeneration;
  refreshInventoryGeneration = inventoryGeneration;
  try {
    await operation;
  } finally {
    if (refreshing === operation) refreshing = null;
  }
}

async function refreshInventory() {
  const generation = sessionGeneration;
  const inventoryRevision = inventoryGeneration;
  const result = await api("/api/devices");
  if (generation !== sessionGeneration || inventoryRevision !== inventoryGeneration) return;
  devices = result.devices;
  matterNodes = result.matterNodes;
  signedIn(true);
  $("retention").textContent =
    `Updates every 15 seconds. Offline after three missed reports (minimum 90 seconds). History retained for ${result.retentionDays} days.`;
  render();
}

async function logs(append = false) {
  const id = selected;
  if (!id) return;
  const result = await api(
    `/api/devices/${encodeURIComponent(id)}/logs?limit=50${append && cursor ? `&before=${cursor}` : ""}`,
  );
  if (selected !== id) return;
  showingOlder = append;
  if (!append) $("log-rows").replaceChildren();
  for (const entry of result.logs) {
    const row = node("tr");
    const stateCell = node("td");
    stateCell.append(status(entry.heartbeat.status));
    row.append(
      node("td", stamp(entry.receivedAt)),
      stateCell,
      node("td", `${Math.round(entry.heartbeat.freeHeapBytes / 1024)} KB`),
      node("td", entry.heartbeat.message || "—"),
    );
    $("log-rows").append(row);
  }
  cursor = result.nextCursor;
  $("more").hidden = cursor === null;
  $("no-logs").hidden = $("log-rows").children.length > 0;
}

function select(id) {
  selectedMatter = null;
  selected = id;
  dirty = false;
  cursor = null;
  showingOlder = false;
  $("log-rows").replaceChildren();
  render();
  logs().catch(error);
}
function showCredential(result) {
  credential = { id: result.device.id, token: result.token };
  $("credential-value").value = result.token;
  $("credential-dialog").showModal();
}

function stopScan() {
  scanGeneration += 1;
  clearTimeout(scanTimer);
  scanTimer = null;
  scanController?.abort();
  scanController = null;
}

function renderDiscovered(found) {
  $("scan-results").replaceChildren();
  for (const device of found) {
    const item = node("li", undefined, "discovered-device");
    item.append(node("strong", device.deviceName || "Matter device"));
    item.append(node("span", device.addresses.join(", ") || device.instanceName, "muted network-address"));
    item.append(
      node("span", device.commissioningMode > 0 ? "Ready to pair" : "Pairing mode is off", "discovery-state"),
    );
    const button = node("button", "Pair and register", "primary");
    button.disabled = device.commissioningMode === 0;
    button.addEventListener("click", () => beginPairing(device));
    item.append(button);
    $("scan-results").append(item);
  }
  $("scan-empty").hidden = found.length > 0;
  $("scan-status").textContent = found.length
    ? `${found.length} ${found.length === 1 ? "device" : "devices"} found · Looking for more…`
    : "Looking for devices…";
}

async function scan(generation) {
  if (generation !== scanGeneration || !$("discover-dialog").open) return;
  const controller = new AbortController();
  scanController = controller;
  $("rescan").disabled = true;
  try {
    const result = await api("/api/matter/discover", "GET", undefined, controller.signal);
    if (generation !== scanGeneration || !$("discover-dialog").open) return;
    renderDiscovered(result.devices);
    $("scan-error").hidden = true;
    scanTimer = setTimeout(() => scan(generation), 2000);
  } catch (reason) {
    if (generation !== scanGeneration || controller.signal.aborted || !$("discover-dialog").open) return;
    $("scan-status").textContent = "Scan unavailable";
    $("scan-error").textContent = reason.message;
    $("scan-error").hidden = false;
    $("scan-empty").hidden = true;
  } finally {
    if (generation === scanGeneration) {
      scanController = null;
      $("rescan").disabled = false;
    }
  }
}

function startScan() {
  stopScan();
  $("scan-results").replaceChildren();
  $("scan-empty").hidden = true;
  $("scan-error").hidden = true;
  $("scan-status").textContent = "Scanning your network…";
  scan(scanGeneration);
}

function beginPairing(device) {
  $("discover-dialog").close();
  pairingDevice = device;
  $("matter-code").value = "";
  $("matter-pair-name").textContent = device.deviceName || "Matter device";
  $("matter-pair-progress").textContent = "";
  $("matter-pair-error").textContent = "";
  $("matter-pair-dialog").showModal();
  $("matter-code").focus();
}

$("matter-pair-dialog").addEventListener("cancel", (event) => {
  if (pairing) event.preventDefault();
});
$("matter-pair-dialog").addEventListener("close", () => {
  $("matter-code").value = "";
  pairingDevice = null;
});
$("back-to-discovery").addEventListener("click", () => {
  if (pairing) return;
  $("matter-pair-dialog").close();
  $("discover-dialog").showModal();
  startScan();
});
$("matter-pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pairing || !pairingDevice) return;
  pairing = true;
  const generation = sessionGeneration;
  $("matter-register").disabled = true;
  $("back-to-discovery").disabled = true;
  $("matter-code").disabled = true;
  $("matter-pair-error").textContent = "";
  $("matter-pair-progress").textContent = "Pairing and registering… This can take a few minutes.";
  try {
    const result = await api("/api/matter/register", "POST", {
      code: $("matter-code").value,
      instanceName: pairingDevice.instanceName,
    });
    if (generation !== sessionGeneration) return;
    selected = null;
    selectedMatter = result.node.node_id;
    inventoryGeneration += 1;
    matterNameDirty = false;
    $("matter-pair-dialog").close();
    $("notice").className = "success";
    $("notice").textContent = "Matter device registered.";
    await refresh().catch(() => {
      $("notice").textContent = "Matter device registered. Refresh to check its connection.";
    });
  } catch (reason) {
    if (generation !== sessionGeneration) return;
    $("matter-pair-progress").textContent = "";
    $("matter-pair-error").textContent = reason.message;
    await refresh().catch(() => {});
  } finally {
    pairing = false;
    $("matter-register").disabled = false;
    $("back-to-discovery").disabled = false;
    $("matter-code").disabled = false;
    $("matter-code").value = "";
  }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/login", "POST", { password: $("password").value });
    $("notice").textContent = "";
    await refresh();
  } catch (reason) {
    error(reason);
  } finally {
    $("password").value = "";
    button.disabled = false;
  }
});
$("logout").addEventListener("click", async () => {
  sessionGeneration += 1;
  try {
    await api("/api/logout", "POST", {});
    signedIn(false);
  } catch (reason) {
    error(reason);
  }
});
$("search").addEventListener("input", render);
$("filter").addEventListener("change", render);
for (const column of filterColumns) $("cycle-" + column).addEventListener("click", () => cycleColumn(column));
$("clear-filters").addEventListener("click", () => {
  for (const column of ["type", "capabilities", "group"]) columnFilters[column] = null;
  $("filter").value = "all";
  $("search").value = "";
  render();
});
$("refresh").addEventListener("click", () => {
  $("notice").textContent = "";
  refresh()
    .then(() => logs())
    .catch(error);
});
$("close-detail").addEventListener("click", () => {
  selected = null;
  render();
});
$("close-matter-detail").addEventListener("click", () => {
  selectedMatter = null;
  render();
});
$("matter-name").addEventListener("input", () => {
  matterNameDirty = true;
});
$("matter-name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const nodeId = selectedMatter;
  if (nodeId === null || $("save-matter-name").disabled) return;
  const generation = sessionGeneration;
  $("save-matter-name").disabled = true;
  $("matter-name").disabled = true;
  try {
    const result = await api(`/api/matter/nodes/${nodeId}/name`, "PATCH", { name: $("matter-name").value });
    if (generation !== sessionGeneration) return;
    inventoryGeneration += 1;
    matterNodes = matterNodes.map((device) => (device.nodeId === nodeId ? { ...device, ...result.node } : device));
    if (selectedMatter === nodeId) matterNameDirty = false;
    render();
    $("notice").className = "success";
    $("notice").textContent = "Matter device name saved.";
  } catch (reason) {
    if (generation === sessionGeneration) error(reason);
  } finally {
    $("save-matter-name").disabled = false;
    $("matter-name").disabled = false;
  }
});
for (const id of ["device-name", "device-interval"])
  $(id).addEventListener("input", () => {
    dirty = true;
  });
$("edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api(`/api/devices/${encodeURIComponent(selected)}`, "PATCH", {
      name: $("device-name").value,
      intervalSeconds: Number($("device-interval").value),
    });
    dirty = false;
    $("notice").textContent = "Device saved.";
    await refresh();
  } catch (reason) {
    error(reason);
  } finally {
    button.disabled = false;
  }
});
$("add").addEventListener("click", () => {
  $("discover-dialog").showModal();
  startScan();
});
$("close-discover").addEventListener("click", () => $("discover-dialog").close());
$("discover-dialog").addEventListener("close", stopScan);
$("rescan").addEventListener("click", startScan);
$("manual-enroll").addEventListener("click", () => {
  $("discover-dialog").close();
  $("enroll-error").textContent = "";
  $("enroll-dialog").showModal();
});
$("cancel-enroll").addEventListener("click", () => $("enroll-dialog").close());
$("enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api("/api/devices/enroll", "POST", {
      id: $("enroll-id").value,
      name: $("enroll-name").value,
      intervalSeconds: Number($("enroll-interval").value),
    });
    $("enroll-dialog").close();
    $("enroll-form").reset();
    showCredential(result);
    await refresh();
    select(result.device.id);
  } catch (reason) {
    $("enroll-error").textContent = reason.message;
  } finally {
    button.disabled = false;
  }
});
$("rotate").addEventListener("click", async () => {
  if (!confirm("Replace this credential? The device will need to be provisioned again.")) return;
  try {
    const result = await api(`/api/devices/${encodeURIComponent(selected)}/credential`, "POST", {});
    showCredential(result);
    await refresh();
  } catch (reason) {
    error(reason);
  }
});
$("revoke").addEventListener("click", async () => {
  if (!confirm("Revoke this device's access? It will stop reporting health. History will be kept.")) return;
  try {
    await api(`/api/devices/${encodeURIComponent(selected)}/revoke`, "POST", {});
    await refresh();
  } catch (reason) {
    error(reason);
  }
});
$("more").addEventListener("click", () => logs(true).catch(error));
$("close-credential").addEventListener("click", () => $("credential-dialog").close());
$("credential-dialog").addEventListener("close", () => {
  credential = null;
  $("credential-value").value = "";
});
$("download-credential").addEventListener("click", () => {
  if (!credential) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(credential, null, 2) + "\n"], { type: "application/json" }));
  const link = node("a");
  link.href = url;
  link.download = `${credential.id}-credential.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
refresh().catch((reason) => {
  if (!$("login-section").hidden) $("notice").textContent = "";
  else error(reason);
});
setInterval(() => {
  if (
    !$("inventory").hidden &&
    !$("discover-dialog").open &&
    !$("matter-pair-dialog").open &&
    !$("enroll-dialog").open &&
    !$("credential-dialog").open
  )
    refresh()
      .then(() => {
        if (!showingOlder) return logs();
      })
      .catch(error);
}, 15000);

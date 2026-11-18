import { sessionEndEvent } from "/home/ui.js";
const $ = (id) => document.getElementById(id);
let devices = [];
let healthSettings = null;
let pollTimer = null;
let matterNodes = [];
let goveeDevices = [];
let selectedGovee = null;
let selected = null;
let selectedMatter = null;
let matterGroupDirty = false;
let savingGroup = false;
let groups = [];
let dirty = false;
let detailsGeneration = 0;
let cursor = null;
let credential = null;
let credentialUrl = null;
let refreshing = null;
let refreshGeneration = 0;
let inventoryGeneration = 0;
let refreshInventoryGeneration = 0;
let sessionGeneration = 0;
let showingOlder = false;
let logsLoaded = false;
let logsLoading = false;
let logGeneration = 0;
let scanController = null;
let scanTimer = null;
let scanGeneration = 0;
let pairingDevice = null;
let pairing = false;
let captureSource = null;
let captureSettings = null;
let captureLogs = new Map();
let captureCursor = null;
let capturePaused = false;
let captureGeneration = 0;
function node(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
}

function signedIn(value) {
  $("add").hidden = !value;
  if (!value) {
    stopCaptures();
    clearInterval(pollTimer);
    pollTimer = null;
    sessionGeneration += 1;
    detailsGeneration++;
    selected = null;
    devices = [];
    matterNodes = [];
    goveeDevices = [];
    selectedGovee = null;
    $("govee-detail").hidden = true;
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
  if (response.status === 401 || response.status === 403) document.dispatchEvent(new Event(sessionEndEvent));
  if (!response.ok) throw Object.assign(new Error(result.error || "Request failed"), { status: response.status });
  return result;
}

function error(reason) {
  $("notice").className = "error";
  $("notice").textContent = reason.message || "Request failed";
}
function duration(seconds) {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
function stamp(value) {
  return value === null ? "Awaiting first report" : new Date(value).toLocaleString();
}
function status(value) {
  return node("span", value, `status ${value}`);
}

function render() {
  renderDetail();
  renderMatterDetail();
  renderGoveeDetail();
}

function renderMatterDetail() {
  const device = matterNodes.find((candidate) => candidate.nodeId === selectedMatter);
  $("matter-detail").hidden = !device;
  if (!device) return;
  $("matter-facts").replaceChildren();
  for (const [label, value] of [
    ["Matter node", device.nodeId],
    ["Reported type", device.type],
    ["Category", device.assignedType?.name || device.type],
    ["Connection", device.available ? "Connected" : "Offline"],
    ["Last seen", device.lastSeen === null ? "Not seen yet" : stamp(device.lastSeen)],
    ["Reported uptime", device.uptimeSeconds === null ? "Unavailable" : duration(device.uptimeSeconds)],
    ["Uptime reported", device.uptimeObservedAt === null ? "Unavailable" : stamp(device.uptimeObservedAt)],
    ["Manufacturer", device.vendor || "—"],
    ["Product", device.product || "—"],
    ["Bridge", device.isBridge ? "Yes" : "No"],
    ["Lights and plugs", device.lightEndpoints.length],
    ["Groups", device.groups.join(", ") || "—"],
    ["Capabilities", device.capabilities.join(", ") || "—"],
  ]) {
    const fact = node("div");
    fact.append(node("dt", label), node("dd", value));
    $("matter-facts").append(fact);
  }
  const selectedGroup = matterGroupDirty
    ? $("matter-group").value
    : device.groupIds.length === 1
      ? device.groupIds[0]
      : device.groupIds.length
        ? "__multiple__"
        : "";
  $("matter-group").replaceChildren();
  const unassigned = node("option", "No group");
  unassigned.value = "";
  $("matter-group").append(unassigned);
  if (device.groupIds.length > 1) {
    const multiple = node("option", "Multiple groups");
    multiple.value = "__multiple__";
    multiple.disabled = true;
    $("matter-group").append(multiple);
  }
  for (const group of groups) {
    const option = node("option", group.name);
    option.value = group.id;
    $("matter-group").append(option);
  }
  $("matter-group").value = selectedGroup;
  $("matter-group").disabled = savingGroup || !device.lightEndpoints.length;
  $("save-matter-group").disabled = savingGroup || !device.lightEndpoints.length;
}

function selectMatter(nodeId) {
  selectedGovee = null;
  stopCaptures();
  selected = null;
  selectedMatter = nodeId;
  matterGroupDirty = false;
  render();
}

function renderDetail() {
  const device = devices.find((d) => d.id === selected);
  $("detail").hidden = !device;
  if (!device) return;
  $("device-facts").replaceChildren();
  for (const [label, value] of [
    ["Device ID", device.id],
    ["Status", device.status],
    ["Firmware", device.latest?.firmware || "—"],
    ["IP address", device.latest?.ip || "—"],
    ["First report", stamp(device.registeredAt)],
    ["Last seen", stamp(device.lastSeen)],
    ["Uptime", duration(device.latest?.uptimeSeconds)],
    ["Signal", device.latest?.rssi === undefined ? "—" : `${device.latest.rssi} dBm`],
    ["Free heap", device.latest ? `${Math.round(device.latest.freeHeapBytes / 1024)} KB` : "—"],
    ["Report interval", `${device.intervalSeconds}s`],
    ["Capabilities", "Health reporting"],
    ["Groups", device.groups.join(", ") || "—"],
  ]) {
    const fact = node("div");
    fact.append(node("dt", label), node("dd", value));
    $("device-facts").append(fact);
  }
  if (!dirty) {
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
  goveeDevices = result.goveeDevices;
  groups = result.groups;
  captureSettings = result.i2c;
  healthSettings = result.health;
  $("retention").textContent = `${result.retentionDays} days retained · ${healthSettings.refreshSeconds}s refresh`;
  if (pollTimer === null) pollTimer = setInterval(poll, healthSettings.refreshSeconds * 1000);
  signedIn(true);
  render();
  document.dispatchEvent(new CustomEvent("health-data", { detail: result }));
}

async function logs(append = false) {
  const id = selected;
  const generation = detailsGeneration;
  if (!id || !healthSettings || !$("health-logs").open || (append && (cursor === null || logsLoading))) return;
  const revision = ++logGeneration;
  logsLoading = true;
  $("more").disabled = true;
  try {
    const result = await api(
      `/api/devices/${encodeURIComponent(id)}/logs?limit=${healthSettings.historyLimit}${append && cursor ? `&before=${cursor}` : ""}`,
    );
    if (selected !== id || generation !== detailsGeneration || revision !== logGeneration) return;
    logsLoaded = true;
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
  } finally {
    if (revision === logGeneration) {
      logsLoading = false;
      $("more").disabled = false;
    }
  }
}

function select(id) {
  stopCaptures();
  selectedMatter = null;
  selectedGovee = null;
  selected = id;
  dirty = false;
  cursor = null;
  showingOlder = false;
  logsLoaded = logsLoading = false;
  logGeneration++;
  $("more").disabled = false;
  $("log-rows").replaceChildren();
  render();
  logs().catch(error);
  captureLogs.clear();
  captureCursor = null;
  capturePaused = false;
  $("i2c-pause").textContent = "Pause";
  renderCaptures();
  startCaptures();
}

function stopCaptures() {
  captureGeneration += 1;
  captureSource?.close();
  captureSource = null;
}

function renderCaptures() {
  const entries = [...captureLogs.values()].sort((a, b) => b.id - a.id);
  $("i2c-live").replaceChildren();
  for (const entry of entries) {
    const item = node("div", undefined, "i2c-entry");
    item.append(
      node(
        "span",
        `${stamp(entry.receivedAt)} · Bus ${entry.bus} · #${entry.firstSequence}–${entry.sequence}`,
        "muted",
      ),
    );
    item.append(
      node(
        "code",
        entry.data
          ? entry.data.match(/../g).join(" ").toUpperCase()
          : `EMPTY × ${entry.captures} · ${((entry.endUs - entry.startUs) / 1000000).toFixed(3)}s`,
        "i2c-bytes",
      ),
    );
    if (entry.dropped) item.append(node("strong", `${entry.dropped} capture units lost`, "i2c-gap"));
    if (entry.data && !entry.condensed.startsWith("hex:")) {
      const encoding = node("details", undefined, "i2c-encoding");
      encoding.append(node("summary", "Stored data"), node("code", entry.condensed));
      item.append(encoding);
    }
    $("i2c-live").append(item);
  }
  $("i2c-empty").hidden = entries.length > 0;
  $("i2c-more").hidden = captureCursor === null;
}

function startCaptures() {
  if (
    !selected ||
    !captureSettings ||
    capturePaused ||
    !$("i2c-section").open ||
    $("devices-panel").hidden ||
    !$("device-editor").getClientRects().length
  )
    return;
  stopCaptures();
  const id = selected;
  const generation = captureGeneration;
  $("i2c-status").textContent = "Connecting…";
  const source = new EventSource(`/api/devices/${encodeURIComponent(id)}/i2c/events`);
  captureSource = source;
  source.addEventListener("snapshot", (event) => {
    if (generation !== captureGeneration || selected !== id) return;
    const snapshot = JSON.parse(event.data);
    captureLogs = new Map(snapshot.logs.map((entry) => [entry.id, entry]));
    captureCursor = snapshot.nextCursor;
    $("i2c-status").textContent = "Live · Waiting for captures";
    renderCaptures();
  });
  source.addEventListener("capture", (event) => {
    if (generation !== captureGeneration || selected !== id) return;
    const entry = JSON.parse(event.data);
    captureLogs.set(entry.id, entry);
    const ordered = [...captureLogs.keys()].sort((a, b) => b - a);
    for (const key of ordered.slice(captureSettings.liveRows)) captureLogs.delete(key);
    captureCursor = ordered.length >= captureSettings.liveRows ? ordered[captureSettings.liveRows - 1] : captureCursor;
    $("i2c-status").textContent = `Live · Received ${stamp(entry.receivedAt)}`;
    renderCaptures();
  });
  source.addEventListener("denied", () => {
    if (generation === captureGeneration) document.dispatchEvent(new Event(sessionEndEvent));
  });
  source.onerror = () => {
    if (generation !== captureGeneration || selected !== id) return;
    $("i2c-status").textContent = "Disconnected · Reconnecting…";
    api("/api/session").catch(error);
  };
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
    scanTimer = setTimeout(() => scan(generation), healthSettings.discoveryRefreshSeconds * 1000);
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
    $("matter-pair-dialog").close();
    $("notice").className = "success";
    $("notice").textContent = "Matter device registered.";
    await refresh()
      .then(() => {
        document.dispatchEvent(new CustomEvent("device-selected", { detail: `matter:${result.node.node_id}` }));
      })
      .catch(() => {
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

$("health-logs").addEventListener("toggle", () => {
  if ($("health-logs").open && !logsLoaded) logs().catch(error);
});
$("i2c-section").addEventListener("toggle", () => {
  if ($("i2c-section").open) startCaptures();
  else stopCaptures();
});
$("i2c-pause").addEventListener("click", () => {
  capturePaused = !capturePaused;
  $("i2c-pause").textContent = capturePaused ? "Resume" : "Pause";
  if (capturePaused) {
    stopCaptures();
    $("i2c-status").textContent = "Paused";
  } else startCaptures();
});
$("i2c-more").addEventListener("click", async () => {
  if (!selected || captureCursor === null) return;
  if (!capturePaused) $("i2c-pause").click();
  const id = selected;
  const generation = captureGeneration;
  $("i2c-more").disabled = true;
  try {
    const result = await api(`/api/devices/${encodeURIComponent(id)}/i2c?before=${captureCursor}`);
    if (selected !== id || generation !== captureGeneration) return;
    for (const entry of result.logs) captureLogs.set(entry.id, entry);
    captureCursor = result.nextCursor;
    renderCaptures();
  } catch (reason) {
    error(reason);
  } finally {
    $("i2c-more").disabled = false;
  }
});
$("matter-group").addEventListener("change", () => {
  matterGroupDirty = true;
});
$("matter-group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const nodeId = selectedMatter;
  const value = $("matter-group").value;
  if (nodeId === null || savingGroup || value === "__multiple__") return;
  savingGroup = true;
  const generation = sessionGeneration;
  $("save-matter-group").disabled = true;
  $("matter-group").disabled = true;
  try {
    const result = await api(`/api/matter/nodes/${nodeId}/group`, "PATCH", { groupId: value || null });
    if (generation !== sessionGeneration) return;
    inventoryGeneration += 1;
    matterNodes = matterNodes.map((device) => (device.nodeId === nodeId ? { ...device, ...result.node } : device));
    if (selectedMatter === nodeId) matterGroupDirty = false;
    await refresh();
    $("notice").className = "success";
    $("notice").textContent = "Matter device group saved.";
  } catch (reason) {
    if (generation === sessionGeneration) error(reason);
  } finally {
    savingGroup = false;
    renderMatterDetail();
  }
});
$("device-interval").addEventListener("input", () => {
  dirty = true;
});
$("edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const id = selected;
  const generation = sessionGeneration;
  if (!id || button.disabled) return;
  button.disabled = true;
  try {
    await api(`/api/devices/${encodeURIComponent(id)}`, "PATCH", {
      intervalSeconds: Number($("device-interval").value),
    });
    if (generation !== sessionGeneration) return;
    inventoryGeneration++;
    if (selected === id) dirty = false;
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
    document.dispatchEvent(new CustomEvent("device-selected", { detail: `health:${result.device.id}` }));
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
  if (credentialUrl) URL.revokeObjectURL(credentialUrl);
  credentialUrl = null;
  $("credential-value").value = "";
});
$("download-credential").addEventListener("click", () => {
  if (!credential) return;
  if (credentialUrl) URL.revokeObjectURL(credentialUrl);
  credentialUrl = URL.createObjectURL(
    new Blob([JSON.stringify(credential, null, 2) + "\n"], { type: "application/json" }),
  );
  const link = node("a");
  link.href = credentialUrl;
  link.download = `${credential.id}-credential.json`;
  link.click();
});
export async function loadHealth(refreshHistory = false) {
  inventoryGeneration++;
  await refresh();
  if (refreshHistory || !showingOlder) await logs();
  startCaptures();
}
export function resetHealth() {
  signedIn(false);
}
export function closeHealth() {
  stopCaptures();
}
export function selectHealth(key) {
  const current =
    selected !== null
      ? `health:${selected}`
      : selectedMatter !== null
        ? `matter:${selectedMatter}`
        : selectedGovee !== null
          ? `target:${selectedGovee}`
          : null;
  if (key === current) {
    if (!captureSource) startCaptures();
    return;
  }
  detailsGeneration++;
  stopCaptures();
  selected = selectedMatter = selectedGovee = null;
  $("health-logs").open = false;
  $("i2c-section").open = false;
  if (key?.startsWith("health:")) select(key.slice("health:".length));
  else if (key?.startsWith("matter:")) selectMatter(Number(key.slice("matter:".length)));
  else if (key?.startsWith("target:")) selectGovee(key.slice("target:".length));
  else render();
}
function poll() {
  if (
    !$("management").hidden &&
    !$("devices-panel").hidden &&
    !$("discover-dialog").open &&
    !$("matter-pair-dialog").open &&
    !$("enroll-dialog").open &&
    !$("credential-dialog").open
  )
    refresh()
      .then(() => {
        if (!showingOlder && !logsLoading) return logs();
      })
      .catch(error);
}

function selectGovee(id) {
  stopCaptures();
  selected = null;
  selectedMatter = null;
  selectedGovee = id;
  render();
}
function renderGoveeDetail() {
  const device = goveeDevices.find((device) => device.id === selectedGovee);
  $("govee-detail").hidden = !device;
  if (!device) return;
  $("govee-facts").replaceChildren();
  for (const [label, value] of [
    ["Device ID", device.id],
    ["Type", device.type],
    ["Category", device.assignedType?.name || device.type],
    ["Capabilities", device.capabilities.join(", ") || "—"],
    ["Groups", device.groups.join(", ") || "—"],
    ["Status source", device.statusSource],
    ["Connection", device.status],
    ["Checked", stamp(device.checkedAt)],
    ["Result", device.reason || "Cloud connection flag received"],
  ]) {
    const fact = node("div");
    fact.append(node("dt", label), node("dd", value));
    $("govee-facts").append(fact);
  }
}

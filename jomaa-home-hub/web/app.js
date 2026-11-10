const $ = (id) => document.getElementById(id);
let devices = [];
let selected = null;
let dirty = false;
let cursor = null;
let credential = null;
let refreshing = false;
let sessionGeneration = 0;
let showingOlder = false;

function node(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
}

function signedIn(value) {
  $("login-section").hidden = value;
  for (const id of ["inventory", "add", "logout"]) $(id).hidden = !value;
  if (!value) {
    sessionGeneration += 1;
    selected = null;
    devices = [];
    $("detail").hidden = true;
    $("enroll-dialog").close();
    $("credential-dialog").close();
  }
}

async function api(path, method = "GET", data) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (response.status === 401) signedIn(false);
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

function error(reason) {
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
  const counts = devices.reduce((all, device) => {
    all[device.status] = (all[device.status] || 0) + 1;
    return all;
  }, {});
  $("summary").textContent =
    `${devices.length} devices · ${counts.online || 0} online · ${counts.offline || 0} offline · ${counts.degraded || 0} degraded`;
  const search = $("search").value.toLowerCase();
  const filter = $("filter").value;
  const visible = devices.filter(
    (d) => (filter === "all" || d.status === filter) && `${d.name} ${d.id}`.toLowerCase().includes(search),
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
      stateCell,
      node("td", lastSeen(device.lastSeen)),
      node("td", duration(device.latest?.uptimeSeconds)),
      node("td", device.latest?.rssi === undefined ? "—" : `${device.latest.rssi} dBm`),
    );
    $("device-rows").append(row);
  }
  $("empty").hidden = visible.length > 0;
  $("empty").textContent = devices.length
    ? "No devices match your filters."
    : "No devices yet. Add a device to get started.";
  renderDetail();
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
  if (refreshing) return;
  refreshing = true;
  const generation = sessionGeneration;
  try {
    const result = await api("/api/devices");
    if (generation !== sessionGeneration) return;
    devices = result.devices;
    signedIn(true);
    $("retention").textContent =
      `Updates every 15 seconds. Offline after three missed reports (minimum 90 seconds). History retained for ${result.retentionDays} days.`;
    render();
  } finally {
    refreshing = false;
  }
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
  if (!$("inventory").hidden && !$("enroll-dialog").open && !$("credential-dialog").open)
    refresh()
      .then(() => {
        if (!showingOlder) return logs();
      })
      .catch(error);
}, 15000);

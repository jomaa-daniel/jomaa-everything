const $ = (id) => document.getElementById(id);
let catalog = { types: [], groups: [], devices: [] };
let generation = 0;
const drafts = new Map();
const openGroups = new Set();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function signedIn(value) {
  $("login-section").hidden = value;
  for (const id of ["management", "logout", "refresh"]) $(id).hidden = !value;
  if (!value) {
    generation++;
    catalog = { types: [], groups: [], devices: [] };
    drafts.clear();
    openGroups.clear();
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
  if (response.status === 401 || response.status === 403) signedIn(false);
  if (!response.ok) throw Object.assign(new Error(body.error || "Request failed"), { status: response.status });
  return body;
}

function credentials() {
  const username = $("username").value.trim();
  return { password: $("password").value, ...(username ? { username } : {}) };
}

function error(reason) {
  $("notice").className = "";
  $("notice").textContent = reason.message || "Request failed";
}

async function load() {
  const current = generation;
  const result = await api("/api/manage");
  if (current !== generation) return;
  catalog = result;
  signedIn(true);
  const focused = document.activeElement?.id;
  render();
  if (focused) ($(focused) || $("refresh")).focus();
}

async function update(data, button) {
  const current = generation;
  const key = data.key || `${data.action.split(".")[0]}:${data.id}`;
  const savedDraft = drafts.get(key);
  button.disabled = true;
  try {
    await api("/api/manage", data);
    if (current !== generation) return false;
    if (drafts.get(key) === savedDraft) drafts.delete(key);
    try {
      await load();
    } catch (reason) {
      if (current === generation) error(new Error(`Changes saved, but refresh failed: ${reason.message}`));
      return true;
    }
    if (current !== generation) return false;
    $("notice").className = "success";
    $("notice").textContent = "Changes saved.";
    return true;
  } catch (reason) {
    error(reason);
    return false;
  } finally {
    button.disabled = false;
  }
}

function renderList(kind, values) {
  const list = $(kind + "-list");
  list.replaceChildren();
  for (const item of values) {
    const row = element("li");
    if (kind === "type") {
      const swatch = element("span", undefined, "type-swatch");
      swatch.style.setProperty("--type-hue", item.hue);
      row.append(swatch);
    }
    const input = element("input");
    const key = `${kind}:${item.id}`;
    input.id = key + ":name";
    input.value = drafts.get(key) ?? item.name;
    input.addEventListener("input", () => drafts.set(key, input.value));
    input.maxLength = 80;
    input.setAttribute("aria-label", `Rename ${kind} ${item.name}`);
    const save = element("button", "Save");
    save.id = key + ":save";
    save.setAttribute("aria-label", `Save ${kind} ${item.name}`);
    save.addEventListener("click", () => update({ action: kind + ".rename", id: item.id, name: input.value }, save));
    const remove = element("button", "Delete", "danger");
    remove.id = key + ":delete";
    remove.setAttribute("aria-label", `Delete ${kind} ${item.name}`);
    remove.addEventListener("click", () => {
      const consequence =
        kind === "group"
          ? "The room will be removed from Lights and parent groups. Devices will lose this group assignment."
          : "Devices will lose this type assignment.";
      if (confirm(`Delete ${item.name}? ${consequence}`)) update({ action: kind + ".delete", id: item.id }, remove);
    });
    row.append(input, save, remove);
    list.append(row);
  }
  $(kind + "s-empty").hidden = values.length > 0;
}

function render() {
  renderList("type", catalog.types);
  renderList("group", catalog.groups);
  $("assignment-rows").replaceChildren();
  for (const device of catalog.devices) {
    const draft = { typeId: device.typeId, groupIds: device.groupIds, ...drafts.get(device.key) };
    const row = element("tr");
    const name = element("td");
    name.append(element("strong", device.name), element("span", device.source, "device-id"));
    const typeCell = element("td");
    const type = element("select");
    type.id = device.key + ":type";
    type.setAttribute("aria-label", `Type for ${device.name}`);
    const reported = element("option", "Use reported type");
    reported.value = "";
    type.append(reported);
    for (const value of catalog.types) {
      const option = element("option", value.name);
      option.value = value.id;
      type.append(option);
    }
    type.value = catalog.types.some((value) => value.id === draft.typeId) ? draft.typeId : "";
    typeCell.append(type);
    const groupsCell = element("td");
    const choices = element("details", undefined, "group-choice");
    choices.open = openGroups.has(device.key);
    choices.addEventListener("toggle", () =>
      choices.open ? openGroups.add(device.key) : openGroups.delete(device.key),
    );
    const summary = element("summary");
    summary.id = device.key + ":groups";
    choices.append(summary);
    const inputs = [];
    for (const group of catalog.groups) {
      const label = element("label");
      const input = element("input");
      input.type = "checkbox";
      input.value = group.id;
      input.checked = draft.groupIds.includes(group.id);
      input.id = device.key + ":group:" + group.id;
      inputs.push(input);
      label.append(input, element("span", group.name));
      choices.append(label);
    }
    const remember = (field) => {
      const groupIds = inputs.filter((input) => input.checked).map((input) => input.value);
      drafts.set(device.key, {
        ...drafts.get(device.key),
        [field]: field === "typeId" ? type.value || null : groupIds,
      });
      const selected = catalog.groups.filter((group) => groupIds.includes(group.id)).map((group) => group.name);
      summary.textContent = selected.join(", ") || "No group";
      summary.setAttribute("aria-label", `Groups for ${device.name}: ${summary.textContent}`);
    };
    type.addEventListener("change", () => remember("typeId"));
    for (const input of inputs) input.addEventListener("change", () => remember("groupIds"));
    const selected = catalog.groups.filter((group) => draft.groupIds.includes(group.id)).map((group) => group.name);
    summary.textContent = selected.join(", ") || "No group";
    summary.setAttribute("aria-label", `Groups for ${device.name}: ${summary.textContent}`);
    groupsCell.append(choices);
    const action = element("td");
    const save = element("button", "Save", "primary");
    save.id = device.key + ":save";
    save.setAttribute("aria-label", `Save assignment for ${device.name}`);
    save.addEventListener("click", () => {
      const groupIds = inputs.filter((input) => input.checked).map((input) => input.value);
      const typeId = type.value || null;
      const data = { action: "device.assign", key: device.key };
      if (typeId !== device.typeId) data.typeId = typeId;
      if (JSON.stringify([...groupIds].sort()) !== JSON.stringify([...device.groupIds].sort()))
        data.groupIds = groupIds;
      if ("typeId" in data || "groupIds" in data) update(data, save);
    });
    action.append(save);
    row.append(name, element("td", device.reportedType), typeCell, groupsCell, action);
    for (const [index, label] of ["Device", "Reported type", "Assigned type", "Groups", ""].entries())
      row.children[index].dataset.label = label;
    $("assignment-rows").append(row);
  }
  $("devices-empty").hidden = catalog.devices.length > 0;
  $("matter-unavailable").hidden = catalog.matterConnected;
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/login", credentials());
    await load();
    $("notice").textContent = "";
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
    await api("/api/logout", {});
    signedIn(false);
  } catch (reason) {
    error(reason);
  }
});
$("refresh").addEventListener("click", () => load().catch(error));
for (const kind of ["type", "group"]) {
  $(kind + "-create").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (await update({ action: kind + ".create", name: $(kind + "-name").value }, event.submitter))
      $(kind + "-name").value = "";
  });
}
load().catch((reason) => {
  if (reason.status === 401) $("notice").textContent = "";
  else error(reason);
});

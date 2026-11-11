/**
 * @typedef {{ brightness: boolean, colorTemperature: boolean, color: boolean }} Features
 * @typedef {{ id: string, name: string, kind: string, members: string[], features: Features }} Target
 *   members is empty for devices.
 * @typedef {{ on: boolean, brightness: number, colorTemperaturePct: number }} LightState
 * @typedef {{ devices: Record<string, LightState>, failed: Record<string, string> }} Observation
 * @typedef {{ on?: boolean, brightness?: number, colorTemperaturePct?: number, color?: string }} Changes
 * @typedef {{ text: string, error: boolean }} Message
 */

const $ = (id) => document.getElementById(id);

const FEATURES = ["brightness", "colorTemperature", "color"];
const TEMPERATURE_STOPS = [
  [0, [255, 150, 70]],
  [50, [255, 222, 186]],
  [100, [222, 234, 255]],
];
const CUSTOM_COLORS_KEY = "device-panel.custom-colors";
const DEFAULT_CUSTOM_COLORS = { "custom-1": "#667eea", "custom-2": "#764ba2" };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

class HttpError extends Error {
  /** @param {number} status @param {string} message @param {Record<string, string>} failed */
  constructor(status, message, failed) {
    super(message);
    this.status = status;
    this.failed = failed;
  }
}

/** Thrown by api() after a 401; the session has already been ended. */
class SessionExpired extends Error {}

class BadResponse extends Error {}

const app = {
  /** null until the first response tells whether the session cookie is valid. */
  authenticated: /** @type {boolean | null} */ (null),
  /** Bumps on sign-in and sign-out; responses from older sessions are dropped. */
  session: 0,
  /** Bumps when the selection or target list changes; older reads are dropped. */
  view: 0,
  targets: /** @type {Map<string, Target>} */ (new Map()),
  targetsLoaded: false,
  selected: /** @type {string[]} */ ([]),
  selectionInitialized: false,
  observation: /** @type {Observation | null} */ (null),
  stale: false,
  loading: false,
  busy: false,
  queued: /** @type {Changes | null} */ (null),
  selectedColor: /** @type {string | null} */ (null),
  customColors: { ...DEFAULT_CUSTOM_COLORS },
  editing: /** @type {string | null} */ (null),
  error: /** @type {Message} */ ({ text: "", error: true }),
  errorDetail: "",
  loginMessage: /** @type {Message} */ ({ text: "", error: false }),
  reconnect: false,
};

// Response parsing

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function expect(condition) {
  if (!condition) throw new BadResponse("the hub sent an unexpected response");
}

/** @returns {Features} */
function parseFeatures(value) {
  expect(isRecord(value));
  for (const feature of FEATURES) expect(typeof value[feature] === "boolean");
  return {
    brightness: value.brightness,
    colorTemperature: value.colorTemperature,
    color: value.color,
  };
}

/** @returns {Target} */
function parseTarget(value) {
  expect(
    isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.kind === "string",
  );
  const members = value.kind === "room" ? value.members : [];
  expect(
    Array.isArray(members) && members.every((id) => typeof id === "string"),
  );
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    members: [...members],
    features: parseFeatures(value.features),
  };
}

/** @returns {Target[]} */
function parseTargets(value) {
  expect(isRecord(value) && Array.isArray(value.targets));
  return value.targets.map(parseTarget);
}

/** @returns {LightState} */
function parseLightState(value) {
  expect(
    isRecord(value) &&
      typeof value.on === "boolean" &&
      typeof value.brightness === "number" &&
      typeof value.colorTemperaturePct === "number",
  );
  return {
    on: value.on,
    brightness: value.brightness,
    colorTemperaturePct: value.colorTemperaturePct,
  };
}

/** @returns {Record<string, string>} */
function parseFailed(value) {
  expect(isRecord(value));
  return Object.fromEntries(
    Object.entries(value).map(([id, reason]) => {
      expect(typeof reason === "string");
      return [id, reason];
    }),
  );
}

/** @returns {Observation} */
function parseObservation(value) {
  expect(isRecord(value) && isRecord(value.devices));
  return {
    devices: Object.fromEntries(
      Object.entries(value.devices).map(([id, state]) => [
        id,
        parseLightState(state),
      ]),
    ),
    failed: parseFailed(value.failed),
  };
}

// Hub API

/**
 * Sends one request. A 401 outside sign-in ends the session and throws
 * SessionExpired; other failures throw HttpError with the hub's message and
 * any per-device failures.
 * @param {string} path @param {"GET" | "POST"} method @param {object | null} body
 */
async function api(path, method = "GET", body = null) {
  const session = app.session;
  const response = await fetch(path, {
    method,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    headers: body === null ? {} : { "Content-Type": "application/json" },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const isJSON = (response.headers.get("Content-Type") ?? "").startsWith(
    "application/json",
  );
  const data = isJSON ? await response.json() : null;
  if (response.ok) {
    expect(isJSON);
    return data;
  }
  if (response.status === 401 && path !== "/api/login") {
    if (session === app.session) sessionEnded();
    throw new SessionExpired("signed out");
  }
  throw new HttpError(
    response.status,
    isRecord(data) && typeof data.error === "string"
      ? data.error
      : `the hub answered with HTTP ${response.status}`,
    isRecord(data) && isRecord(data.failed) ? parseFailed(data.failed) : {},
  );
}

const targetPath = (id, action) =>
  `/api/targets/${encodeURIComponent(id)}/${action}`;

/** Reads every target's state and merges their devices and failures. */
async function readState(ids) {
  const results = await Promise.allSettled(
    ids.map((id) => api(targetPath(id, "state")).then(parseObservation)),
  );
  const expired = results.find(
    (result) =>
      result.status === "rejected" && result.reason instanceof SessionExpired,
  );
  if (expired) throw expired.reason;
  if (results.every((result) => result.status === "rejected"))
    throw results[0].reason;
  /** @type {Observation} */
  const merged = { devices: {}, failed: {} };
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      Object.assign(merged.devices, result.value.devices);
      Object.assign(merged.failed, result.value.failed);
    } else {
      merged.failed[ids[index]] = describe(result.reason);
    }
  });
  return merged;
}

// Messages

const sentence = (text) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

function describe(error) {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "The hub took too long to respond.";
  if (error instanceof TypeError)
    return "Can't reach the hub. Check your connection.";
  if (error instanceof HttpError || error instanceof BadResponse)
    return sentence(error.message);
  return "Something went wrong.";
}

function reasonText(reason) {
  if (/HTTP (401|403)/.test(reason)) return "access refused";
  if (/HTTP 429/.test(reason)) return "too many requests, try again shortly";
  return "not responding";
}

/** Groups failures by reason: "Lamp A, Lamp B: not responding." */
function failureText(failed) {
  const groups = new Map();
  for (const [id, reason] of Object.entries(failed)) {
    const text = reasonText(reason);
    groups.set(text, [...(groups.get(text) ?? []), nameOf(id)]);
  }
  return [...groups]
    .map(([text, names]) => `${names.sort().join(", ")}: ${text}.`)
    .join(" ");
}

function showError(text, detail = "") {
  app.error = { text, error: true };
  app.errorDetail = detail;
  if (text) announce(text);
}

function showFailures(failed, problems) {
  const detail = Object.entries(failed)
    .map(([id, reason]) => `${nameOf(id)}: ${reason}`)
    .join("\n");
  showError(
    [...problems, failureText(failed)].filter(Boolean).join(" "),
    detail,
  );
}

function announce(text) {
  $("announcer").textContent = text;
}

// Targets and state

const nameOf = (id) => app.targets.get(id)?.name ?? id;

/** @returns {Features} */
const featuresOf = (id) =>
  app.targets.get(id)?.features ?? {
    brightness: false,
    colorTemperature: false,
    color: false,
  };

/** Every device id under a target, following nested rooms. */
function deviceIds(target, seen = new Set()) {
  if (target.kind !== "room") return [target.id];
  if (seen.has(target.id)) return [];
  seen.add(target.id);
  return target.members.flatMap((id) => {
    const member = app.targets.get(id);
    return member ? deviceIds(member, seen) : [id];
  });
}

/** The selected targets combined, or null when nothing is selected. */
function selection() {
  const chosen = app.selected.flatMap((id) => app.targets.get(id) ?? []);
  if (!chosen.length) return null;
  return {
    name: chosen.map((target) => target.name).join(" + "),
    single: chosen.length === 1 ? chosen[0] : null,
    deviceCount: new Set(chosen.flatMap((target) => deviceIds(target))).size,
    features: Object.fromEntries(
      FEATURES.map((feature) => [
        feature,
        chosen.some((target) => target.features[feature]),
      ]),
    ),
  };
}

/**
 * The observed devices reduced to what the controls show. Brightness and
 * temperature come from the lit devices, or from all devices when none is lit.
 */
function summarize() {
  const devices = Object.entries(app.observation?.devices ?? {}).map(
    ([id, state]) => ({ state, features: featuresOf(id) }),
  );
  const lit = devices.filter((device) => device.state.on);
  const pick = (feature, field) => {
    const values = [
      ...new Set(
        (lit.length ? lit : devices)
          .filter((device) => device.features[feature])
          .map((device) => device.state[field]),
      ),
    ];
    return {
      value: values.length ? values[0] : null,
      mixed: values.length > 1,
    };
  };
  return {
    total: devices.length,
    on: lit.length,
    brightness: pick("brightness", "brightness"),
    temperature: pick("colorTemperature", "colorTemperaturePct"),
  };
}

/** @param {Observation} observation @param {Changes} changes */
function optimistic(observation, changes) {
  return {
    ...observation,
    devices: Object.fromEntries(
      Object.entries(observation.devices).map(([id, state]) => {
        const features = featuresOf(id);
        return [
          id,
          {
            on: changes.on ?? state.on,
            brightness:
              features.brightness && changes.brightness !== undefined
                ? changes.brightness
                : state.brightness,
            colorTemperaturePct:
              features.colorTemperature &&
              changes.colorTemperaturePct !== undefined
                ? changes.colorTemperaturePct
                : state.colorTemperaturePct,
          },
        ];
      }),
    ),
  };
}

// Colors

function interpolate(value) {
  const index = value >= 50 ? 1 : 0;
  const [start, from] = TEMPERATURE_STOPS[index];
  const [end, to] = TEMPERATURE_STOPS[index + 1];
  const t = (value - start) / (end - start);
  return from.map((channel, i) => Math.round(channel + (to[i] - channel) * t));
}

const rgb = (channels) => `rgb(${channels.join(" ")})`;

const hexChannels = (hex) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** True when dark text reads better than white on the color. */
function isLight(channels) {
  const [r, g, b] = channels.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18;
}

function temperatureWord(value) {
  if (value < 35) return "Warm";
  if (value > 65) return "Cool";
  return "Neutral";
}

function loadCustomColors() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY) ?? "null");
  } catch {
    stored = null;
  }
  return Object.fromEntries(
    Object.entries(DEFAULT_CUSTOM_COLORS).map(([id, color]) => [
      id,
      isRecord(stored) &&
      typeof stored[id] === "string" &&
      HEX_COLOR.test(stored[id])
        ? stored[id]
        : color,
    ]),
  );
}

function saveCustomColors() {
  try {
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(app.customColors));
  } catch {
    showError("This browser couldn't save the custom color.");
  }
}

const swatchColor = (button) =>
  button.dataset.color ?? app.customColors[button.dataset.custom];

function paintSwatches() {
  document.querySelectorAll(".swatch").forEach((button) => {
    button.style.setProperty("--swatch", swatchColor(button));
  });
}

// Sessions

/** Starts a fresh session; responses from the previous one are ignored. */
function startSession(authenticated) {
  Object.assign(app, {
    authenticated,
    session: app.session + 1,
    view: app.view + 1,
    targets: new Map(),
    targetsLoaded: false,
    selected: [],
    selectionInitialized: false,
    observation: null,
    stale: false,
    loading: false,
    busy: false,
    queued: null,
    selectedColor: null,
    error: { text: "", error: true },
    errorDetail: "",
    reconnect: false,
  });
  $("color-dialog").close();
}

function sessionEnded() {
  const wasSignedIn = app.authenticated === true;
  startSession(false);
  app.loginMessage = {
    text: wasSignedIn ? "Your session ended. Sign in again." : "",
    error: false,
  };
  render();
  if (wasSignedIn) $("password").focus();
}

// Actions

/** Loads the target list, keeps the selection, and reads its state. */
async function refresh() {
  const session = app.session;
  const view = ++app.view;
  app.loading = true;
  app.reconnect = false;
  render();
  try {
    const targets = parseTargets(await api("/api/targets"));
    if (session !== app.session || view !== app.view) return;
    app.authenticated = true;
    app.targets = new Map(targets.map((target) => [target.id, target]));
    app.targetsLoaded = true;
    const initial =
      targets.find((target) => target.kind === "room") ?? targets[0];
    app.selected = app.selectionInitialized
      ? app.selected.filter((id) => app.targets.has(id))
      : initial
        ? [initial.id]
        : [];
    app.selectionInitialized = true;
    buildToolbar();
    showError("");
    if (app.selected.length) {
      const observation = await readState(app.selected);
      if (session !== app.session || view !== app.view) return;
      app.observation = observation;
      app.stale = false;
      showFailures(observation.failed, []);
    } else {
      app.observation = null;
    }
  } catch (error) {
    if (
      session !== app.session ||
      view !== app.view ||
      error instanceof SessionExpired
    )
      return;
    if (app.authenticated === true) {
      app.stale = app.observation !== null;
      showError(describe(error));
    } else {
      app.authenticated = false;
      app.loginMessage = { text: describe(error), error: true };
      app.reconnect = true;
    }
  } finally {
    if (session === app.session && view === app.view) {
      app.loading = false;
      render();
    }
  }
}

async function selectTargets(ids) {
  if (app.authenticated !== true) return;
  const session = app.session;
  const view = ++app.view;
  app.selected = [...new Set(ids)].filter((id) => app.targets.has(id));
  app.observation = null;
  app.stale = false;
  app.selectedColor = null;
  app.queued = null;
  app.loading = app.selected.length > 0;
  showError("");
  render();
  if (!app.loading) return;
  try {
    const observation = await readState(app.selected);
    if (session !== app.session || view !== app.view) return;
    app.observation = observation;
    showFailures(observation.failed, []);
  } catch (error) {
    if (
      session !== app.session ||
      view !== app.view ||
      error instanceof SessionExpired
    )
      return;
    showError(describe(error));
  } finally {
    if (session === app.session && view === app.view) {
      app.loading = false;
      render();
    }
  }
}

/** Sends changes to the selection; while a command runs, the latest changes wait. */
function command(changes) {
  if (app.authenticated !== true || !app.selected.length || app.loading) return;
  if (app.busy) {
    app.queued = { ...app.queued, ...changes };
    return;
  }
  send(changes);
}

/** @param {Changes} changes */
async function send(changes) {
  const session = app.session;
  const view = app.view;
  const ids = [...app.selected];
  const previous = app.observation;
  app.observation = previous && optimistic(previous, changes);
  app.busy = true;
  showError("");
  announce("Applying…");
  render();
  /** @type {Record<string, string>} */
  const failed = {};
  const problems = [];
  try {
    const results = await Promise.allSettled(
      ids.map((id) => api(targetPath(id, "command"), "POST", changes)),
    );
    if (session !== app.session || view !== app.view) return;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      const error = result.reason;
      if (error instanceof SessionExpired) return;
      if (error instanceof HttpError && Object.keys(error.failed).length)
        Object.assign(failed, error.failed);
      else problems.push(`${nameOf(ids[index])}: ${describe(error)}`);
    }
    if (!problems.length && !Object.keys(failed).length) {
      if (changes.color !== undefined) app.selectedColor = changes.color;
      if (changes.colorTemperaturePct !== undefined) app.selectedColor = null;
    }
    try {
      const observation = await readState(ids);
      if (session !== app.session || view !== app.view) return;
      Object.assign(failed, observation.failed);
      const answered = Object.keys(observation.devices).length > 0;
      app.observation = answered ? observation : previous;
      app.stale = !answered && previous !== null;
    } catch (error) {
      if (
        session !== app.session ||
        view !== app.view ||
        error instanceof SessionExpired
      )
        return;
      app.observation = previous;
      app.stale = previous !== null;
      problems.push(describe(error));
    }
    showFailures(failed, problems);
    if (!app.error.text) announce("Done.");
  } finally {
    if (session === app.session) {
      app.busy = false;
      render();
      const next = app.queued;
      app.queued = null;
      if (next) command(next);
    }
  }
}

// Rendering

/** Rebuilds the room buttons and device picker from the target list. */
function buildToolbar() {
  const rooms = [...app.targets.values()].filter(
    (target) => target.kind === "room",
  );
  $("rooms").replaceChildren(
    ...rooms.map((room) => {
      const button = document.createElement("button");
      button.className = "room-btn";
      button.dataset.room = room.id;
      button.textContent = room.name;
      return button;
    }),
  );

  const devices = [...app.targets.values()].filter(
    (target) => target.kind !== "room",
  );
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Device…";
  placeholder.disabled = true;
  $("target-picker").replaceChildren(
    placeholder,
    ...devices.map((device) => {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = device.name;
      return option;
    }),
  );
}

function render() {
  const signedIn = app.authenticated === true;
  $("connecting").hidden = app.authenticated !== null;
  $("login-section").hidden = app.authenticated !== false;
  $("toolbar").hidden = !signedIn;
  $("controller").hidden = !signedIn;
  renderLogin();
  renderNotice();
  if (!signedIn) return;
  const chosen = selection();
  const summary = summarize();
  renderToolbar(chosen);
  renderPower(chosen, summary);
  renderSettings(chosen, summary);
}

function renderLogin() {
  $("login-message").textContent = app.loginMessage.text;
  $("login-message").hidden = !app.loginMessage.text;
  $("login-message").classList.toggle("error", app.loginMessage.error);
  $("reconnect").hidden = !app.reconnect;
}

function renderNotice() {
  const text = app.authenticated === true ? app.error.text : "";
  $("notice").textContent = text;
  $("notice").title = app.errorDetail;
  $("notice").hidden = !text;
}

function renderToolbar(chosen) {
  $("rooms").hidden = !$("rooms").childElementCount;
  $("rooms")
    .querySelectorAll(".room-btn")
    .forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(app.selected.includes(button.dataset.room)),
      );
    });
  const picker = $("target-picker");
  $("picker").hidden = picker.options.length < 2;
  picker.value =
    chosen?.single && chosen.single.kind !== "room" ? chosen.single.id : "";
  $("refresh").setAttribute("aria-busy", String(app.loading));
}

function powerState(chosen, summary) {
  if (!app.targetsLoaded) return "Loading…";
  if (!app.targets.size) return "Add devices in the hub configuration.";
  if (!chosen) return "Choose a room to control.";
  if (app.loading && !app.observation) return "Loading…";
  if (!summary.total) return "Not responding";
  const last = app.stale ? " · last known" : "";
  if (!summary.on) return `Off${last}`;
  if (summary.on < summary.total)
    return `${summary.on} of ${summary.total} on${last}`;
  const { value, mixed } = summary.brightness;
  return value === null || mixed ? `On${last}` : `On · ${value}%${last}`;
}

function renderPower(chosen, summary) {
  const power = $("power-toggle");
  const name = !app.targetsLoaded
    ? ""
    : !app.targets.size
      ? "No lights yet"
      : (chosen?.name ?? "No room selected");
  $("power-name").textContent = name;
  $("power-state").textContent = powerState(chosen, summary);
  $("target-title").textContent = name;
  $("target-description").textContent = !chosen
    ? ""
    : chosen.single?.kind === "govee"
      ? "Govee device"
      : chosen.single?.kind === "matter"
        ? "Matter device"
        : `${chosen.deviceCount} ${chosen.deviceCount === 1 ? "device" : "devices"}`;

  const on = summary.on > 0;
  const partial = on && summary.on < summary.total;
  power.disabled = !chosen;
  power.setAttribute("aria-checked", String(on));
  power.classList.toggle("on", on);
  power.classList.toggle("partial", partial);
  power.classList.toggle("busy", app.busy || app.loading);

  const glow = app.selectedColor
    ? hexChannels(app.selectedColor)
    : interpolate(summary.temperature.value ?? 50);
  const brightness = summary.brightness.value ?? 100;
  power.style.setProperty("--glow", rgb(glow));
  power.style.setProperty("--glow-ink", isLight(glow) ? "#1d1405" : "#fff");
  power.style.setProperty(
    "--level",
    String((0.35 + 0.65 * (brightness / 100)) * (partial ? 0.5 : 1)),
  );
}

function renderSettings(chosen, summary) {
  $("controls").disabled = !chosen;
  $("controls").classList.toggle("off", summary.total > 0 && !summary.on);
  for (const [id, feature] of [
    ["brightness-setting", "brightness"],
    ["temperature-setting", "colorTemperature"],
    ["color-setting", "color"],
  ]) {
    $(id).hidden = chosen
      ? !chosen.features[feature]
      : ![...app.targets.values()].some((target) => target.features[feature]);
  }

  const brightness = summary.brightness;
  $("brightness-value").textContent = brightness.mixed ? "Mixed" : "";
  document.querySelectorAll("[data-brightness]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(
        !brightness.mixed &&
          Number(button.dataset.brightness) === brightness.value,
      ),
    );
  });

  const temperature = summary.temperature;
  const slider = $("temperature");
  slider.disabled = temperature.value === null;
  slider.value = String(temperature.value ?? 50);
  $("temperature-setting").classList.toggle(
    "inactive",
    app.selectedColor !== null,
  );
  showTemperature(
    temperature.value,
    app.selectedColor !== null
      ? "Color"
      : temperature.mixed
        ? "Mixed"
        : temperature.value === null
          ? ""
          : temperatureWord(temperature.value),
  );

  document.querySelectorAll(".swatch").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(app.selectedColor === swatchColor(button)),
    );
  });
}

function showTemperature(value, label) {
  $("temperature-wrap").style.setProperty("--pct", `${value ?? 50}%`);
  $("temperature-value").textContent = label;
  $("temperature").setAttribute(
    "aria-valuetext",
    value === null ? "Unknown" : temperatureWord(value),
  );
}

// Events

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  app.loginMessage = { text: "", error: false };
  renderLogin();
  try {
    await api("/api/login", "POST", { password: $("password").value });
    $("password").value = "";
    startSession(true);
    await refresh();
    $("power-toggle").focus();
  } catch (error) {
    app.loginMessage = { text: describe(error), error: true };
    renderLogin();
    $("password").focus();
  } finally {
    button.disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", "POST", {});
  } catch (error) {
    if (!(error instanceof SessionExpired)) {
      showError(describe(error));
      render();
      return;
    }
  }
  startSession(false);
  app.loginMessage = { text: "Signed out.", error: false };
  render();
  $("password").focus();
});

$("refresh").addEventListener("click", refresh);
$("reconnect").addEventListener("click", refresh);

$("target-picker").addEventListener("change", () =>
  selectTargets([$("target-picker").value]),
);

$("rooms").addEventListener("click", (event) => {
  const button = event.target.closest("[data-room]");
  if (!button) return;
  const id = button.dataset.room;
  const rooms = app.selected.filter(
    (selected) => app.targets.get(selected)?.kind === "room",
  );
  selectTargets(
    rooms.includes(id)
      ? rooms.filter((selected) => selected !== id)
      : [...rooms, id],
  );
});

$("power-toggle").addEventListener("click", () =>
  command({ on: summarize().on === 0 }),
);

document.querySelectorAll("[data-brightness]").forEach((button) => {
  button.addEventListener("click", () =>
    command({ on: true, brightness: Number(button.dataset.brightness) }),
  );
});

$("temperature").addEventListener("input", () => {
  const value = Number($("temperature").value);
  $("temperature-setting").classList.remove("inactive");
  showTemperature(value, temperatureWord(value));
});
$("temperature").addEventListener("change", () =>
  command({ on: true, colorTemperaturePct: Number($("temperature").value) }),
);

document.querySelectorAll(".swatch").forEach((button) => {
  button.addEventListener("click", () =>
    command({ on: true, color: swatchColor(button) }),
  );
});

document.querySelectorAll("[data-edit]").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.edit;
    app.editing = id;
    $("color").value = app.customColors[id];
    $("custom-title").textContent = document
      .querySelector(`[data-custom="${id}"]`)
      .getAttribute("aria-label");
    $("color-dialog").showModal();
  });
});

$("cancel-color").addEventListener("click", () => $("color-dialog").close());

$("color-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = app.editing;
  if (id === null) return;
  const color = $("color").value;
  app.customColors = { ...app.customColors, [id]: color };
  saveCustomColors();
  paintSwatches();
  $("color-dialog").close();
  command({ on: true, color });
});

$("color-dialog").addEventListener("close", () => {
  app.editing = null;
});

$("temperature-wrap").style.setProperty(
  "--track",
  `linear-gradient(to right, ${TEMPERATURE_STOPS.map(
    ([stop, channels]) => `${rgb(channels)} ${stop}%`,
  ).join(", ")})`,
);
app.customColors = loadCustomColors();
paintSwatches();
render();
refresh();

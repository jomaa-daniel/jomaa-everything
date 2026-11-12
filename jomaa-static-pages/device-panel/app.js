/**
 * @typedef {{ brightness: boolean, colorTemperature: boolean, color: boolean }} Features
 * @typedef {{ id: string, name: string, kind: string, members: string[], features: Features }} Target
 *   members is empty for devices.
 * @typedef {{ on: boolean, brightness: number, colorTemperaturePct: number }} LightState
 * @typedef {{ devices: Record<string, LightState>, failed: Record<string, string> }} Observation
 * @typedef {{ on?: boolean, brightness?: number, colorTemperaturePct?: number, color?: string }} Changes
 * @typedef {{ text: string, error: boolean }} Message
 * @typedef {{ key: string, name: string, ids: string[] }} Tab
 * @typedef {"on" | "off" | "offline" | "pending" | "unknown"} DeviceStatus
 */

const $ = (id) => document.getElementById(id);

const FEATURES = ["brightness", "colorTemperature", "color"];
const TEMPERATURE_STOPS = [
  [0, [255, 150, 70]],
  [50, [255, 222, 186]],
  [100, [222, 234, 255]],
];
const CUSTOM_COLORS_KEY = "device-panel.custom-colors";
const DEFAULT_CUSTOM_COLORS = { "custom-1": "#007aff", "custom-2": "#af52de" };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const REFRESH_INTERVAL_MS = 60_000;

/** Colors offered for the custom swatches: vivid hues, then softer tints. */
const PALETTE = [
  "#ff0000",
  "#ff6b2c",
  "#ff8000",
  "#ffcc00",
  "#c7e600",
  "#34c759",
  "#00c7a3",
  "#32ade6",
  "#007aff",
  "#5856d6",
  "#af52de",
  "#ff2d92",
  "#ff8a80",
  "#ffab80",
  "#ffc680",
  "#ffe680",
  "#e3f280",
  "#8fe0a4",
  "#80e3d1",
  "#99d6f2",
  "#80bcff",
  "#aaa9eb",
  "#d7a8ee",
  "#ff96c8",
];

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
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
  tabs: /** @type {Tab[]} */ ([]),
  selected: /** @type {string[]} */ ([]),
  selectionInitialized: false,
  observation: /** @type {Observation | null} */ (null),
  /** Devices whose command the hub hasn't answered yet. */
  pending: /** @type {Set<string>} */ (new Set()),
  /** Devices that failed to answer or to take the last command, with reasons. */
  failed: /** @type {Record<string, string>} */ ({}),
  /** Whether the status row is expanded to name devices that aren't answering. */
  statusOpen: false,
  stale: false,
  loading: false,
  busy: false,
  queued: /** @type {Changes | null} */ (null),
  selectedColor: /** @type {string | null} */ (null),
  /** Which swatch the selected color came from, by identity, not hex value. */
  selectedSwatch: /** @type {string | null} */ (null),
  customColors: { ...DEFAULT_CUSTOM_COLORS },
  editing: /** @type {string | null} */ (null),
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

/** The devices that didn't take a command, by id. @returns {Record<string, string>} */
function parseCommandResult(value) {
  expect(isRecord(value));
  return parseFailed(value.failed);
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
 * Sends one request. A 401 or 403 outside sign-in ends the session and throws
 * SessionExpired; other failures throw HttpError with the hub's message.
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
  if (
    (response.status === 401 || response.status === 403) &&
    path !== "/api/login"
  ) {
    const refusal =
      response.status === 403 &&
      isRecord(data) &&
      typeof data.error === "string"
        ? data.error
        : null;
    if (session === app.session) sessionEnded(refusal);
    throw new SessionExpired("signed out");
  }
  throw new HttpError(
    response.status,
    isRecord(data) && typeof data.error === "string"
      ? data.error
      : `the hub answered with HTTP ${response.status}`,
  );
}

const targetPath = (id, action) =>
  `/api/targets/${encodeURIComponent(id)}/${action}`;

/**
 * Reads every target's state and merges their devices and failures. A target
 * whose read fails marks each of its devices as failed.
 */
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
      const reason = describe(result.reason);
      for (const id of targetDeviceIds(ids[index])) merged.failed[id] = reason;
    }
  });
  return merged;
}

// Messages

const sentence = (text) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

const HUB_TIMEOUT = "The hub took too long to respond.";
const HUB_UNREACHABLE = "Can't reach the hub. Check your connection.";

function describe(error) {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return HUB_TIMEOUT;
  if (error instanceof TypeError) return HUB_UNREACHABLE;
  if (error instanceof HttpError || error instanceof BadResponse)
    return sentence(error.message);
  return "Something went wrong.";
}

function reasonText(reason) {
  if (/HTTP (401|403)/.test(reason)) return "access refused";
  if (/HTTP 429/.test(reason)) return "too many requests, try again shortly";
  if (reason === HUB_TIMEOUT) return "the hub took too long";
  if (reason === HUB_UNREACHABLE) return "can't reach the hub";
  return "not responding";
}

/** Marks every selected device as not answering after a whole read failed. */
function unreachable(error) {
  const reason = describe(error);
  for (const id of selectedDevices()) app.failed[id] = reason;
  app.stale = app.observation !== null;
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

function targetDeviceIds(id) {
  const target = app.targets.get(id);
  return target ? deviceIds(target) : [id];
}

/** The device ids under the selection, in a stable order. */
const selectedDevices = () => [
  ...new Set(app.selected.flatMap(targetDeviceIds)),
];

/** The selected targets combined, or null when nothing is selected. */
function selection() {
  const chosen = app.selected.flatMap((id) => app.targets.get(id) ?? []);
  if (!chosen.length) return null;
  return {
    name: chosen.map((target) => target.name).join(" + "),
    single: chosen.length === 1 ? chosen[0] : null,
    deviceCount: selectedDevices().length,
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

/** @param {LightState} state @param {Changes} changes @param {Features} features */
function applyChanges(state, changes, features) {
  return {
    on: changes.on ?? state.on,
    brightness:
      features.brightness && changes.brightness !== undefined
        ? changes.brightness
        : state.brightness,
    colorTemperaturePct:
      features.colorTemperature && changes.colorTemperaturePct !== undefined
        ? changes.colorTemperaturePct
        : state.colorTemperaturePct,
  };
}

/** @returns {DeviceStatus} */
function deviceStatus(id) {
  if (app.pending.has(id)) return "pending";
  if (id in app.failed) return "offline";
  const state = app.observation?.devices[id];
  if (state) return state.on ? "on" : "off";
  return "unknown";
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

/** A dim-to-bright gradient in one hue, for the brightness track. */
function brightnessGradient(channels) {
  const dim = channels.map((channel) => Math.round(channel * 0.25));
  const bright = channels.map((channel) =>
    Math.round(channel + (255 - channel) * 0.75),
  );
  return `linear-gradient(to right, ${rgb(dim)}, ${rgb(channels)} 55%, ${rgb(bright)})`;
}

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
    announce("This browser couldn't save the custom color.");
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
    tabs: [],
    selected: [],
    selectionInitialized: false,
    observation: null,
    pending: new Set(),
    failed: {},
    statusOpen: false,
    stale: false,
    loading: false,
    busy: false,
    queued: null,
    selectedColor: null,
    selectedSwatch: null,
    reconnect: false,
  });
  $("tab-list").replaceChildren();
  $("color-dialog").close();
}

/** Shows sign-in; refusal is the hub's message when the account lacks access. */
function sessionEnded(refusal = null) {
  const wasSignedIn = app.authenticated === true;
  startSession(false);
  app.loginMessage = {
    text: refusal ?? (wasSignedIn ? "Your session ended. Sign in again." : ""),
    error: refusal !== null,
  };
  render();
  if (wasSignedIn || refusal !== null) $("password").focus();
}

// Actions

/**
 * Stores a fresh read of the selection. Devices that didn't answer show as
 * red dots, which the status row names when expanded.
 */
function observed(observation) {
  app.observation = observation;
  app.failed = { ...observation.failed };
  app.stale = false;
}

/**
 * Loads the target list, keeps the selection, and reads its state. A
 * background refresh leaves the controls usable and shows no loading state.
 */
async function refresh(background = false) {
  const session = app.session;
  const view = ++app.view;
  app.loading = !background;
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
    buildTabs();
    if (app.selected.length) {
      const observation = await readState(app.selected);
      if (session !== app.session || view !== app.view) return;
      observed(observation);
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
      unreachable(error);
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
  app.pending = new Set();
  app.failed = {};
  app.stale = false;
  app.selectedColor = null;
  app.selectedSwatch = null;
  app.queued = null;
  app.loading = app.selected.length > 0;
  render();
  if (!app.loading) return;
  try {
    const observation = await readState(app.selected);
    if (session !== app.session || view !== app.view) return;
    observed(observation);
  } catch (error) {
    if (
      session !== app.session ||
      view !== app.view ||
      error instanceof SessionExpired
    )
      return;
    unreachable(error);
  } finally {
    if (session === app.session && view === app.view) {
      app.loading = false;
      render();
    }
  }
}

/** Sends changes to the selection; while a command is being sent, the latest changes wait. */
function command(changes) {
  if (app.authenticated !== true || !app.selected.length || app.loading) return;
  if (app.busy) {
    app.queued = { ...app.queued, ...changes };
    return;
  }
  send(changes);
}

/**
 * Sends a command and shows the requested state right away. Each device is
 * pending until the hub answers; a device the hub reports as failed returns
 * to its previous state and turns red.
 * @param {Changes} changes
 */
async function send(changes) {
  const session = app.session;
  const view = app.view;
  const ids = [...app.selected];
  const devices = selectedDevices();
  const before = app.observation;
  if (before)
    app.observation = {
      ...before,
      devices: Object.fromEntries(
        Object.entries(before.devices).map(([id, state]) => [
          id,
          applyChanges(state, changes, featuresOf(id)),
        ]),
      ),
    };
  app.pending = new Set(devices);
  for (const id of devices) delete app.failed[id];
  app.busy = true;
  announce("Applying…");
  render();

  try {
    const results = await Promise.allSettled(
      ids.map((id) =>
        api(targetPath(id, "command"), "POST", changes).then(
          parseCommandResult,
        ),
      ),
    );
    if (session !== app.session) return;
    if (results.some((result) => result.reason instanceof SessionExpired))
      return;
    if (view !== app.view) return;
    /** @type {Record<string, string>} */
    const failed = {};
    for (const [index, result] of results.entries()) {
      Object.assign(
        failed,
        result.status === "fulfilled"
          ? result.value
          : Object.fromEntries(
              targetDeviceIds(ids[index]).map((id) => [
                id,
                describe(result.reason),
              ]),
            ),
      );
    }
    for (const id of devices) app.pending.delete(id);
    Object.assign(app.failed, failed);
    if (app.observation && before)
      for (const id of Object.keys(failed)) {
        if (before.devices[id])
          app.observation.devices[id] = before.devices[id];
        else delete app.observation.devices[id];
      }
    if (!Object.keys(failed).length) {
      if (changes.color !== undefined) app.selectedColor = changes.color;
      if (changes.colorTemperaturePct !== undefined) {
        app.selectedColor = null;
        app.selectedSwatch = null;
      }
    }
    const count = Object.keys(failed).length;
    announce(count ? `Done. ${count} not answering.` : "Done.");
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

/** Builds the room selector: one entry per room, or one per device without rooms. */
function buildTabs() {
  const targets = [...app.targets.values()];
  const rooms = targets.filter((target) => target.kind === "room");
  /** @type {Tab[]} */
  const tabs = (rooms.length ? rooms : targets).map((target) => ({
    key: target.id,
    name: target.name,
    ids: [target.id],
  }));
  if (JSON.stringify(tabs) === JSON.stringify(app.tabs)) return;
  app.tabs = tabs;
  $("tab-list").replaceChildren(
    ...tabs.map((tab) => {
      const button = document.createElement("button");
      button.className = "room-btn";
      button.dataset.tab = tab.key;
      button.textContent = tab.name;
      return button;
    }),
  );
}

const sameIds = (a, b) =>
  a.length === b.length && a.every((id) => b.includes(id));

function render() {
  const signedIn = app.authenticated === true;
  $("connecting").hidden = app.authenticated !== null;
  $("login-section").hidden = app.authenticated !== false;
  $("controller").hidden = !signedIn;
  $("tabs").hidden = !signedIn || app.tabs.length < 2;
  renderLogin();
  if (!signedIn) return;
  const chosen = selection();
  const summary = summarize();
  renderTabs();
  renderPower(chosen, summary);
  renderDevices();
  renderSettings(chosen, summary);
}

function renderLogin() {
  $("login-message").textContent = app.loginMessage.text;
  $("login-message").hidden = !app.loginMessage.text;
  $("login-message").classList.toggle("error", app.loginMessage.error);
  $("reconnect").hidden = !app.reconnect;
}

function renderTabs() {
  $("tab-list")
    .querySelectorAll(".room-btn")
    .forEach((button) => {
      const tab = app.tabs.find((item) => item.key === button.dataset.tab);
      if (tab && sameIds(tab.ids, app.selected))
        button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
}

/** Text for what the controls can't show on their own, or "". */
function powerState(chosen, summary) {
  if (!app.targetsLoaded || (app.loading && !app.observation))
    return "Loading…";
  if (!app.targets.size) return "No lights yet";
  if (!chosen) return "No room selected";
  if (!summary.total) return "Not responding";
  const notes = [];
  if (summary.on && summary.on < summary.total)
    notes.push(`${summary.on} of ${summary.total} on`);
  if (app.stale) notes.push("last known");
  return notes.join(" · ");
}

function renderPower(chosen, summary) {
  const power = $("power-toggle");
  const tab = app.tabs.find((item) => sameIds(item.ids, app.selected));
  $("target-title").textContent = chosen
    ? (tab?.name ?? chosen.name)
    : "Lights";
  $("target-description").textContent = !chosen
    ? ""
    : `${chosen.deviceCount} ${chosen.deviceCount === 1 ? "device" : "devices"}`;
  $("power-state").textContent = powerState(chosen, summary);

  const on = summary.on > 0;
  const partial = on && summary.on < summary.total;
  power.setAttribute("aria-checked", String(on));
  power.classList.toggle("on", on);
  power.classList.toggle("busy", app.busy || app.loading);

  const glow = app.selectedColor
    ? hexChannels(app.selectedColor)
    : interpolate(summary.temperature.value ?? 50);
  const brightness = summary.brightness.value ?? 100;
  power.style.setProperty("--glow", rgb(glow));
  power.style.setProperty("--glow-ink", isLight(glow) ? "#1d1405" : "#fff");
  // The brightness track is a dim-to-bright scale of the light's own color.
  $("brightness-wrap").style.setProperty("--track", brightnessGradient(glow));
  power.style.setProperty(
    "--level",
    String((0.35 + 0.65 * (brightness / 100)) * (partial ? 0.5 : 1)),
  );
}

const STATUS_TEXT = {
  on: "on",
  off: "off",
  offline: "not answering",
  pending: "updating",
  unknown: "unknown",
};

function renderDevices() {
  const ids = selectedDevices();
  const dots = $("device-dots");
  dots.replaceChildren(
    ...ids.map((id) => {
      const status = deviceStatus(id);
      const dot = document.createElement("span");
      dot.className = `dot ${status}`;
      dot.title = `${nameOf(id)}: ${app.failed[id] ?? STATUS_TEXT[status]}`;
      return dot;
    }),
  );
  dots.setAttribute(
    "aria-label",
    ids
      .map((id) => `${nameOf(id)} ${STATUS_TEXT[deviceStatus(id)]}`)
      .join(", "),
  );
  dots.hidden = !ids.length;

  const toggle = $("status-toggle");
  const open = app.statusOpen && ids.length > 0;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.disabled = !ids.length;
  $("controller").classList.toggle("status-open", open);
  const offline = ids.filter((id) => deviceStatus(id) === "offline");
  const problems = $("device-problems");
  problems.replaceChildren(
    ...(offline.length
      ? offline
          .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
          .map((id) => {
            const item = document.createElement("li");
            item.title = app.failed[id];
            const dot = document.createElement("span");
            dot.className = "dot offline";
            const name = document.createElement("span");
            name.className = "problem-name";
            name.textContent = nameOf(id);
            const reason = document.createElement("span");
            reason.className = "problem-reason";
            reason.textContent = reasonText(app.failed[id]);
            item.append(dot, name, reason);
            return item;
          })
      : [
          Object.assign(document.createElement("li"), {
            className: "problem-none",
            textContent:
              ids.length === 1
                ? "The device is answering."
                : `All ${ids.length} devices are answering.`,
          }),
        ]),
  );
  problems.hidden = !open;
}

function renderSettings(chosen, summary) {
  $("controls").classList.toggle("disabled", !chosen);
  $("controls").classList.toggle("off", summary.total > 0 && !summary.on);
  document
    .querySelectorAll("#controls button")
    .forEach((button) => (button.disabled = !chosen));
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
  const brightnessSlider = $("brightness");
  brightnessSlider.disabled = !chosen || brightness.value === null;
  brightnessSlider.value = String(brightness.value ?? 100);
  $("brightness-value").textContent =
    brightness.value === null
      ? ""
      : brightness.mixed
        ? "Mixed"
        : `${brightness.value}%`;
  showBrightness(brightness.value, brightness.mixed);

  const temperature = summary.temperature;
  const slider = $("temperature");
  slider.disabled = !chosen || temperature.value === null;
  slider.value = String(temperature.value ?? 50);
  $("temperature-setting").classList.toggle(
    "inactive",
    app.selectedColor !== null,
  );
  $("temperature-value").textContent =
    app.selectedColor !== null
      ? "Color set"
      : temperature.value === null
        ? ""
        : temperatureWord(temperature.value);
  showTemperature(temperature.value);

  const swatchKey = (button) =>
    button.dataset.custom
      ? `custom:${button.dataset.custom}`
      : `color:${button.dataset.color}`;
  document.querySelectorAll(".swatch").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(
        app.selectedSwatch !== null
          ? app.selectedSwatch === swatchKey(button)
          : app.selectedColor === swatchColor(button),
      ),
    );
  });
  const selectedSwatch = [...document.querySelectorAll(".swatch")].find(
    (button) =>
      app.selectedSwatch !== null
        ? app.selectedSwatch === swatchKey(button)
        : app.selectedColor === swatchColor(button),
  );
  $("color-value").textContent = selectedSwatch
    ? (selectedSwatch.getAttribute("aria-label") ?? "")
    : app.selectedColor
      ? app.selectedColor
      : chosen
        ? "White"
        : "";
}

function showBrightness(value, mixed = false) {
  $("brightness-wrap").style.setProperty("--pct", `${value ?? 100}%`);
  $("brightness").setAttribute(
    "aria-valuetext",
    value === null ? "Unknown" : mixed ? "Mixed" : `${value}%`,
  );
}

function showTemperature(value) {
  $("temperature-wrap").style.setProperty("--pct", `${value ?? 50}%`);
  $("temperature").setAttribute(
    "aria-valuetext",
    value === null ? "Unknown" : temperatureWord(value),
  );
}

function editCustom(id) {
  app.editing = id;
  $("custom-title").textContent = document
    .querySelector(`[data-custom="${id}"]`)
    .getAttribute("aria-label");
  $("color-grid")
    .querySelectorAll("[data-pick]")
    .forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.pick === app.customColors[id]),
      );
    });
  $("color-dialog").showModal();
  (
    $("color-grid").querySelector('[aria-pressed="true"]') ??
    $("color-grid").querySelector("[data-pick]")
  ).focus();
}

function buildColorGrid() {
  $("color-grid").replaceChildren(
    ...PALETTE.map((color) => {
      const button = document.createElement("button");
      button.className = "pick";
      button.dataset.pick = color;
      button.setAttribute("aria-label", color);
      button.setAttribute("aria-pressed", "false");
      button.style.setProperty("--swatch", color);
      return button;
    }),
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
    const username = $("username").value.trim();
    await api("/api/login", "POST", {
      password: $("password").value,
      ...(username ? { username } : {}),
    });
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

$("reconnect").addEventListener("click", () => refresh());

$("tab-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  const tab = app.tabs.find((item) => item.key === button?.dataset.tab);
  if (tab && !sameIds(tab.ids, app.selected)) selectTargets(tab.ids);
});

$("power-toggle").addEventListener("click", () =>
  command({ on: summarize().on === 0 }),
);

$("status-toggle").addEventListener("click", () => {
  app.statusOpen = !app.statusOpen;
  render();
});

$("brightness").addEventListener("input", () => {
  showBrightness(Number($("brightness").value));
  $("brightness-value").textContent = `${$("brightness").value}%`;
});
$("brightness").addEventListener("change", () =>
  command({ on: true, brightness: Number($("brightness").value) }),
);

$("temperature").addEventListener("input", () => {
  $("temperature-setting").classList.remove("inactive");
  $("temperature-value").textContent = temperatureWord(
    Number($("temperature").value),
  );
  showTemperature(Number($("temperature").value));
  if (app.selectedColor === null)
    $("brightness-wrap").style.setProperty(
      "--track",
      brightnessGradient(interpolate(Number($("temperature").value))),
    );
});
$("temperature").addEventListener("change", () =>
  command({ on: true, colorTemperaturePct: Number($("temperature").value) }),
);

document.querySelectorAll(".swatch").forEach((button) => {
  button.addEventListener("click", () => {
    app.selectedSwatch = button.dataset.custom
      ? `custom:${button.dataset.custom}`
      : `color:${button.dataset.color}`;
    command({ on: true, color: swatchColor(button) });
  });
});

document.querySelectorAll("[data-edit]").forEach((button) => {
  button.addEventListener("click", () => editCustom(button.dataset.edit));
});

$("cancel-color").addEventListener("click", () => $("color-dialog").close());

$("color-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-pick]");
  const id = app.editing;
  if (!button || id === null) return;
  const color = button.dataset.pick;
  app.customColors = { ...app.customColors, [id]: color };
  app.selectedSwatch = `custom:${id}`;
  saveCustomColors();
  paintSwatches();
  $("color-dialog").close();
  command({ on: true, color });
});

$("color-dialog").addEventListener("close", () => {
  app.editing = null;
});

const canRefreshQuietly = () =>
  document.visibilityState === "visible" &&
  app.authenticated === true &&
  !app.busy &&
  !app.loading &&
  !app.pending.size &&
  !$("color-dialog").open;

document.addEventListener("visibilitychange", () => {
  if (canRefreshQuietly()) refresh(true);
});
setInterval(() => {
  if (canRefreshQuietly()) refresh(true);
}, REFRESH_INTERVAL_MS);

$("temperature-wrap").style.setProperty(
  "--track",
  `linear-gradient(to right, ${TEMPERATURE_STOPS.map(
    ([stop, channels]) => `${rgb(channels)} ${stop}%`,
  ).join(", ")})`,
);
app.customColors = loadCustomColors();
buildColorGrid();
paintSwatches();
render();
refresh();

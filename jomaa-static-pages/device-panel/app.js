const $ = (id) => document.getElementById(id);
let targets = [];
let selected = null;
let observed = null;
let authenticated = false;
let loading = false;
let busy = false;
let session = 0;
let selectedColor = null;
let activeCustom = null;
let observationStale = false;
const customColors = { "custom-1": "#667eea", "custom-2": "#764ba2" };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function notice(text, isError = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", isError);
  $("notice").hidden =
    !text ||
    (!isError && authenticated) ||
    text === "Sign in to control your lights." ||
    text === "Signed out.";
  updateStatus();
}

function updateStatus() {
  const failed = $("notice").classList.contains("error");
  const status = loading
    ? "Loading"
    : busy
      ? "Applying settings"
      : failed
        ? "Request failed"
        : observed?.state
          ? "Connected"
          : "Not connected";
  $("status-dot").classList.toggle(
    "ok",
    !loading && !busy && !failed && Boolean(observed?.state),
  );
  $("status-dot").classList.toggle("error", failed);
  $("status-dot").title = status;
  $("status-dot").setAttribute("aria-label", status);
}

function signedIn(value) {
  authenticated = value;
  $("login-section").hidden = value;
  $("controller").hidden = !value;
  $("toolbar").hidden = !value;
  if (!value) {
    session += 1;
    targets = [];
    selected = null;
    observed = null;
    busy = false;
    loading = false;
    selectedColor = null;
    observationStale = false;
    $("color-dialog").close();
    render();
  }
}

async function api(path, method = "GET", data) {
  const generation = session;
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (response.status === 401 && generation === session) signedIn(false);
  if (!response.ok) {
    const error = new Error(
      result.error ||
        failureMessage(result.failed) ||
        "Request failed. Try again.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

function failureMessage(failed = {}) {
  return Object.entries(failed)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, reason]) => {
      const name = targets.find((target) => target.id === id)?.name || id;
      const description = /HTTP (401|403)/.test(reason)
        ? "the hub's device access was refused"
        : /HTTP 429/.test(reason)
          ? "too many requests; try again shortly"
          : "not responding";
      return `${name}: ${description}`;
    })
    .join("; ");
}

function errorMessage(error) {
  if (error.name === "TimeoutError")
    return "The hub took too long to respond. Refresh to check your lights.";
  if (error instanceof TypeError)
    return "Cannot reach your hub. Check your connection and try Refresh.";
  return error.message;
}

function targetPath(action) {
  return `/api/targets/${encodeURIComponent(selected)}/${action}`;
}

function renderPicker() {
  $("target-picker").replaceChildren();
  for (const [heading, group] of [
    ["Rooms", targets.filter((target) => target.kind === "room")],
    ["Devices", targets.filter((target) => target.kind !== "room")],
  ]) {
    if (!group.length) continue;
    const list = node("optgroup");
    list.label = heading;
    for (const target of group) {
      const option = node("option", target.name);
      option.value = target.id;
      option.selected = target.id === selected;
      list.append(option);
    }
    $("target-picker").append(list);
  }
  $("target-picker").disabled = busy || loading;
}

function memberIds(target) {
  if (target.kind !== "room") return [target.id];
  return [
    ...new Set(
      target.members.flatMap((id) => {
        const child = targets.find((item) => item.id === id);
        return child?.kind === "room" ? memberIds(child) : [id];
      }),
    ),
  ];
}

function temperatureDisplay(value, mixed = false) {
  const signed = value * 2 - 100;
  const display = `${signed > 0 ? "+" : signed < 0 ? "−" : ""}${Math.abs(signed)}%`;
  $("temperature-wrap").style.setProperty("--pct", `${value}%`);
  $("temperature-value").textContent = mixed ? `${display} · Mixed` : display;
  $("temperature").setAttribute(
    "aria-valuetext",
    `${display}${mixed ? ", varies by device" : ""}`,
  );
}

function render() {
  renderPicker();
  updateStatus();
  $("refresh").disabled = loading || busy;
  $("controller").setAttribute("aria-busy", String(busy || loading));
  $("empty").hidden = targets.length > 0;
  const target = targets.find((item) => item.id === selected);
  $("controls").hidden = !target;
  if (!target) {
    $("state-note").hidden = true;
    return;
  }
  $("target-title").textContent = target.name;
  $("target-description").textContent =
    target.kind === "room"
      ? `${memberIds(target).length} ${memberIds(target).length === 1 ? "device" : "devices"} · Control together`
      : target.kind === "govee"
        ? "Govee device"
        : "Matter device";
  $("controls").disabled = busy || loading;
  for (const [id, feature] of [
    ["brightness-setting", "brightness"],
    ["temperature-setting", "colorTemperature"],
    ["color-setting", "color"],
  ]) {
    $(id).hidden = !target.features[feature];
  }
  const state = observed?.state;
  const states = Object.entries(observed?.devices || {});
  const varies = (field, feature) => {
    const values = states
      .filter(
        ([id]) =>
          !feature || targets.find((item) => item.id === id)?.features[feature],
      )
      .map(([, item]) => item[field]);
    return new Set(values).size > 1;
  };
  const mixedPower = varies("on");
  $("power-state").textContent = loading
    ? "Loading…"
    : !state
      ? "Unknown"
      : mixedPower
        ? "Mixed"
        : state.on
          ? "On"
          : "Off";
  $("power-toggle").classList.toggle("on", Boolean(state?.on));
  $("power-toggle").classList.toggle("busy", busy || loading);
  $("power-toggle").setAttribute("aria-checked", String(Boolean(state?.on)));
  $("power-toggle").setAttribute(
    "aria-description",
    `${target.name}: ${$("power-state").textContent}. Activate to turn ${state?.on ? "off" : "on"}.`,
  );
  const featureState = (feature) =>
    states.find(
      ([id, item]) =>
        item.on &&
        targets.find((target) => target.id === id)?.features[feature],
    )?.[1] ||
    states.find(
      ([id]) => targets.find((target) => target.id === id)?.features[feature],
    )?.[1];
  const brightness = featureState("brightness")?.brightness;
  const mixedBrightness = varies("brightness", "brightness");
  $("brightness-value").textContent =
    brightness === undefined
      ? "Unknown"
      : `${brightness}%${mixedBrightness ? ", varies by device" : ""}`;
  document.querySelectorAll("[data-brightness]").forEach((button) => {
    const active =
      Number(button.dataset.brightness) === brightness && !mixedBrightness;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = brightness === undefined;
  });
  const temperature = featureState("colorTemperature")?.colorTemperaturePct;
  $("temperature").value = String(temperature ?? 50);
  temperatureDisplay(
    temperature ?? 50,
    varies("colorTemperaturePct", "colorTemperature"),
  );
  if (temperature === undefined) {
    $("temperature-value").textContent = "Unknown";
    $("temperature").setAttribute("aria-valuetext", "Unknown");
  }
  $("temperature").disabled = !featureState("colorTemperature");
  $("state-note").textContent = loading
    ? "Reading your lights…"
    : observationStale
      ? "Showing the last known state. Refresh to check your lights."
      : !state
        ? "No device state available. You can still try a power command or Refresh."
        : "";
  $("state-note").hidden = (Boolean(state) && !observationStale) || loading;
  document.querySelectorAll(".color-btn").forEach((button) => {
    const color = button.dataset.color || customColors[button.id];
    button.setAttribute("aria-pressed", String(selectedColor === color));
  });
}

async function selectTarget(id) {
  if (busy || loading) return;
  selected = id;
  observed = null;
  observationStale = false;
  selectedColor = null;
  const generation = session;
  loading = true;
  notice("");
  render();
  try {
    const result = await api(targetPath("state"));
    if (generation !== session) return;
    observed = result;
    notice(
      failureMessage(result.failed),
      Object.keys(result.failed).length > 0,
    );
  } catch (error) {
    if (generation === session || error.status === 401)
      notice(errorMessage(error), true);
  } finally {
    if (generation === session) {
      loading = false;
      render();
    }
  }
}

async function refresh() {
  if (busy || loading) return;
  const generation = session;
  loading = true;
  notice("Reading your lights…");
  render();
  try {
    const result = await api("/api/targets");
    if (generation !== session) return;
    targets = result.targets;
    signedIn(true);
    if (!targets.some((target) => target.id === selected)) {
      selected =
        targets.find((target) => target.kind === "room")?.id ||
        targets[0]?.id ||
        null;
    }
    observed = null;
    observationStale = false;
    loading = false;
    if (selected) await selectTarget(selected);
    else notice("");
  } catch (error) {
    if (generation === session && !authenticated)
      $("login-section").hidden = false;
    if (generation === session || error.status === 401)
      notice(
        error.status === 401
          ? "Sign in to control your lights."
          : errorMessage(error),
        error.status !== 401,
      );
  } finally {
    if (generation === session) {
      loading = false;
      render();
    }
  }
}

async function command(changes) {
  if (busy || loading || !selected || !authenticated) return;
  const generation = session;
  const previousObserved = observed;
  if (observed?.state) {
    const apply = (state, features) => ({
      ...state,
      ...(changes.on !== undefined && { on: changes.on }),
      ...(features.brightness &&
        changes.brightness !== undefined && { brightness: changes.brightness }),
      ...(features.colorTemperature &&
        changes.colorTemperaturePct !== undefined && {
          colorTemperaturePct: changes.colorTemperaturePct,
        }),
    });
    observed = {
      ...observed,
      state: apply(
        observed.state,
        targets.find((target) => target.id === selected).features,
      ),
      devices: Object.fromEntries(
        Object.entries(observed.devices).map(([id, state]) => [
          id,
          apply(state, targets.find((target) => target.id === id).features),
        ]),
      ),
    };
  }
  busy = true;
  notice("Applying settings…");
  render();
  let problem = "";
  try {
    await api(targetPath("command"), "POST", changes);
    if (generation === session && changes.color) selectedColor = changes.color;
    if (generation === session && changes.colorTemperaturePct !== undefined)
      selectedColor = null;
  } catch (error) {
    problem = errorMessage(error);
  }
  if (generation !== session) {
    if (!authenticated) notice("Sign in to control your lights.");
    return;
  }
  try {
    const result = await api(targetPath("state"));
    if (generation !== session) return;
    observationStale = Boolean(
      problem && !result.state && previousObserved?.state,
    );
    observed = observationStale ? previousObserved : result;
    const failed = failureMessage(result.failed);
    notice(
      [...new Set([problem, failed].filter(Boolean))].join("; ") ||
        "Settings applied.",
      Boolean(problem || failed),
    );
  } catch (error) {
    if (generation === session) {
      observed = null;
      notice([problem, errorMessage(error)].filter(Boolean).join("; "), true);
    } else if (!authenticated) notice("Sign in to control your lights.");
  } finally {
    if (generation === session) {
      busy = false;
      render();
    }
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  notice("Signing in…");
  try {
    await api("/api/login", "POST", { password: $("password").value });
    $("password").value = "";
    signedIn(true);
    await refresh();
  } catch (error) {
    notice(errorMessage(error), true);
  } finally {
    button.disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  $("logout").disabled = true;
  try {
    await api("/api/logout", "POST", {});
    signedIn(false);
    notice("Signed out.");
  } catch (error) {
    notice(errorMessage(error), true);
  } finally {
    $("logout").disabled = false;
  }
});

$("refresh").addEventListener("click", refresh);
$("reconnect").addEventListener("click", refresh);
$("target-picker").addEventListener("change", () =>
  selectTarget($("target-picker").value),
);
document.querySelectorAll("[data-brightness]").forEach((button) => {
  button.addEventListener("click", () =>
    command({ on: true, brightness: Number(button.dataset.brightness) }),
  );
});
document.querySelectorAll("[data-color]").forEach((button) => {
  button.addEventListener("click", () =>
    command({ on: true, color: button.dataset.color }),
  );
});
$("temperature").addEventListener("input", () =>
  temperatureDisplay(Number($("temperature").value)),
);
$("temperature").addEventListener("change", () =>
  command({ on: true, colorTemperaturePct: Number($("temperature").value) }),
);
for (const id of Object.keys(customColors)) {
  $(id).addEventListener("click", () => {
    activeCustom = id;
    $("color").value = customColors[id];
    $("custom-title").textContent =
      id === "custom-1" ? "Custom color 1" : "Custom color 2";
    $("color-dialog").showModal();
  });
}
$("cancel-color").addEventListener("click", () => $("color-dialog").close());
$("color-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const color = $("color").value;
  customColors[activeCustom] = color;
  $(activeCustom).classList.add("chosen");
  $(activeCustom).style.setProperty("--custom-color", color);
  $("color-dialog").close();
  command({ on: true, color });
});

function initPowerToggle() {
  const toggle = $("power-toggle");
  const knob = toggle.querySelector(".power-toggle-knob");
  let gesture = null;
  let suppressClick = false;
  const canChange = () => authenticated && !busy && !loading && selected;
  const isOn = () => Boolean(observed?.state?.on);
  const offset = (clientX) =>
    Math.max(
      0,
      Math.min(
        gesture.travel,
        (gesture.on ? gesture.travel : 0) + clientX - gesture.startX,
      ),
    );
  const clear = () => {
    gesture = null;
    toggle.classList.remove("dragging");
    knob.style.transform = "";
  };
  toggle.addEventListener("pointerdown", (event) => {
    if (!canChange() || !event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    const pad = parseFloat(getComputedStyle(toggle).paddingLeft);
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      on: isOn(),
      travel: Math.max(0, toggle.clientWidth - pad * 2 - knob.offsetWidth),
      moved: false,
    };
    toggle.classList.add("dragging");
    toggle.setPointerCapture(event.pointerId);
  });
  toggle.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - gesture.startX) > 12) gesture.moved = true;
    knob.style.transform = `translateX(${offset(event.clientX)}px)`;
  });
  toggle.addEventListener("pointerup", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const { moved, travel } = gesture;
    const on = offset(event.clientX) > travel / 2;
    clear();
    if (moved) {
      suppressClick = true;
      if (on !== isOn()) command({ on });
    }
  });
  toggle.addEventListener("pointercancel", () => {
    suppressClick = true;
    clear();
  });
  toggle.addEventListener("lostpointercapture", clear);
  toggle.addEventListener("click", (event) => {
    const ignore = suppressClick && event.detail > 0;
    suppressClick = false;
    if (!ignore && canChange()) command({ on: !isOn() });
  });
}

initPowerToggle();
refresh();

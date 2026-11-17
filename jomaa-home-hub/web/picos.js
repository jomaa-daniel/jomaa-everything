const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
const active = (run) => run && !["passed", "failed"].includes(run.status);

export class PicoPanel {
  constructor(denied) {
    this.denied = denied;
    this.signedIn = false;
    this.epoch = 0;
    this.panelEpoch = 0;
    this.targets = [];
    this.features = [];
    this.selectedFeatures = new Set();
    this.target = null;
    this.run = null;
    this.hostRun = null;
    this.timer = null;
    this.loading = false;
    $("pico-refresh").addEventListener("click", () => this.refresh());
    $("pico-close").addEventListener("click", () => this.close(true));
    $("pico-panel").addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.close(true);
    });
    $("pico-retry").addEventListener("click", () => this.open(this.target, this.opener));
    $("pico-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.flash();
    });
  }

  async api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ([401, 403].includes(response.status)) {
      this.denied();
      throw new Error("Devices access is required");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Pico request failed");
    return result;
  }

  session(value) {
    if (value === this.signedIn) return;
    this.signedIn = value;
    this.epoch++;
    $("usb-picos").hidden = !value;
    if (value) void this.refresh();
    else {
      this.close(false);
      this.targets = [];
      $("pico-targets").replaceChildren();
    }
  }

  async refresh() {
    const epoch = this.epoch;
    $("pico-refresh").disabled = true;
    $("pico-inventory-status").textContent = "Checking USB connections…";
    try {
      const result = await this.api("/api/picos");
      if (epoch !== this.epoch || !this.signedIn) return;
      this.targets = result.targets;
      this.hostRun = result.activeRunId;
      this.pollMilliseconds = result.pollMilliseconds;
      const list = $("pico-targets");
      list.replaceChildren();
      for (const target of this.targets) {
        const button = node("button", undefined, "pico-target");
        button.type = "button";
        button.dataset.targetId = target.id;
        button.append(
          node("strong", target.name),
          node("span", target.mode === "runtime" ? "USB · MicroPython" : "USB · BOOTSEL", "muted"),
        );
        button.addEventListener("click", () => this.open(target, button));
        list.append(button);
        if (this.target?.id === target.id) this.opener = button;
      }
      this.markSelected();
      $("pico-inventory-status").textContent = this.targets.length
        ? `${this.targets.length} connected`
        : "No USB Picos connected. Connect a Pico to the hub server and refresh.";
      this.controls();
    } catch (error) {
      if (epoch === this.epoch) $("pico-inventory-status").textContent = `${error.message}. Use Refresh USB to retry.`;
    } finally {
      if (epoch === this.epoch) $("pico-refresh").disabled = false;
    }
  }

  close(restoreFocus) {
    this.panelEpoch++;
    clearTimeout(this.timer);
    this.timer = null;
    $("pico-panel").hidden = true;
    $("pico-password").value = "";
    if (restoreFocus && this.signedIn && this.opener?.isConnected) this.opener.focus();
    this.target = null;
    this.run = null;
    this.markSelected();
  }

  markSelected() {
    for (const button of $("pico-targets").querySelectorAll(".pico-target"))
      button.setAttribute("aria-pressed", String(button.dataset.targetId === this.target?.id));
  }

  async open(target, opener) {
    if (!target || !this.signedIn) return;
    clearTimeout(this.timer);
    const epoch = ++this.panelEpoch;
    this.target = target;
    this.opener = opener;
    this.run = null;
    this.loading = true;
    this.features = [];
    this.selectedFeatures.clear();
    $("pico-identity").textContent = target.uniqueId || target.name;
    $("pico-description").textContent = target.description;
    $("pico-features").replaceChildren();
    $("pico-ssid").value = "";
    $("pico-password").value = "";
    $("pico-results").hidden = true;
    $("pico-panel-status").textContent = "Loading image options…";
    $("pico-retry").hidden = true;
    this.markSelected();
    if ($("pico-panel").hidden) {
      $("pico-panel").hidden = false;
      $("pico-panel-title").focus();
    }
    this.controls();
    try {
      const catalog = await this.api("/api/picos/catalog");
      if (epoch !== this.panelEpoch) return;
      this.features = catalog.features;
      $("pico-radio").value = catalog.defaultWifiTransport;
      for (const feature of this.features) {
        if (feature.default) this.select(feature.id, true);
        const label = node("label", undefined, "pico-feature");
        const input = node("input");
        input.type = "checkbox";
        input.value = feature.id;
        input.addEventListener("change", () => {
          this.select(feature.id, input.checked);
          this.controls();
        });
        const text = node("span");
        text.append(node("strong", feature.label), node("span", feature.description, "muted"));
        label.append(input, text);
        $("pico-features").append(label);
      }
      $("pico-panel-status").textContent = target.available ? "" : target.unavailableReason;
      if (target.latestRunId) {
        const { run } = await this.api(`/api/picos/runs/${encodeURIComponent(target.latestRunId)}`);
        if (epoch !== this.panelEpoch) return;
        this.showRun(run);
        if (active(run)) this.poll(epoch);
      }
    } catch (error) {
      if (epoch === this.panelEpoch) {
        $("pico-panel-status").textContent = error.message;
        $("pico-retry").hidden = false;
      }
    } finally {
      if (epoch === this.panelEpoch) {
        this.loading = false;
        this.controls();
      }
    }
  }

  select(id, checked) {
    if (checked) {
      if (this.selectedFeatures.has(id)) return;
      this.selectedFeatures.add(id);
      for (const dependency of this.features.find((x) => x.id === id)?.requires || []) this.select(dependency, true);
    } else {
      this.selectedFeatures.delete(id);
      for (const feature of this.features) if (feature.requires.includes(id)) this.select(feature.id, false);
    }
  }

  controls() {
    const busy = active(this.run) || this.submitting;
    for (const input of $("pico-features").querySelectorAll("input"))
      input.checked = this.selectedFeatures.has(input.value);
    $("pico-options").disabled = this.loading || busy;
    $("pico-wifi").disabled = busy;
    $("pico-wifi").hidden = !this.selectedFeatures.has("wifi");
    $("pico-ssid").required = this.selectedFeatures.has("wifi");
    $("pico-flash").disabled =
      !this.target?.available ||
      !this.features.length ||
      !this.selectedFeatures.size ||
      this.loading ||
      busy ||
      (this.hostRun && this.hostRun !== this.run?.id);
  }

  showRun(run) {
    this.run = run;
    if (run.wifiTransport !== null) $("pico-radio").value = run.wifiTransport;
    this.selectedFeatures = new Set(run.features);
    this.hostRun = active(run) ? run.id : null;
    if (this.target) this.target.latestRunId = run.id;
    $("pico-results").hidden = false;
    $("pico-run-status").textContent =
      `${run.status === "passed" ? "Image verified" : run.status === "failed" ? "Image failed verification" : "Imaging in progress"} · ${run.message}`;
    $("pico-run-status").className = run.status === "passed" ? "success" : run.status === "failed" ? "pico-error" : "";
    const checks = $("pico-checks");
    checks.replaceChildren();
    for (const check of run.checks) {
      const row = node("li", undefined, `pico-check ${check.status}`);
      const label = this.features.find((x) => x.id === check.feature)?.label || check.feature;
      row.append(node("strong", `${label} · ${check.status}`), node("span", check.message));
      if (check.evidence) {
        const evidence = check.evidence;
        const summary =
          check.feature === "temperature"
            ? `${evidence.celsius.toFixed(1)} °C`
            : check.feature === "wifi"
              ? `${evidence.transport === "esp8285" ? "ESP8285" : "Native Pico W"} · ${evidence.ip}`
              : check.feature === "health"
                ? `${evidence.reports} new heartbeats · ${evidence.deviceId}`
                : `${evidence.bytes} bytes received · ${evidence.dropped} capture errors`;
        row.append(node("span", summary, "device-id"));
      }
      checks.append(row);
    }
    this.controls();
  }

  async flash() {
    if (!this.target || $("pico-flash").disabled) return;
    const selected = this.features.filter((x) => this.selectedFeatures.has(x.id));
    if (
      !confirm(
        `Flash ${this.target.name} (${this.target.uniqueId || this.target.mode}) with ${selected.map((x) => x.label).join(", ")}? This erases every file on this Pico.`,
      )
    )
      return;
    const epoch = this.panelEpoch;
    const body = { features: selected.map((x) => x.id) };
    if (this.selectedFeatures.has("wifi"))
      body.wifi = { ssid: $("pico-ssid").value, password: $("pico-password").value, transport: $("pico-radio").value };
    this.submitting = true;
    this.controls();
    $("pico-password").value = "";
    try {
      const { run } = await this.api(`/api/picos/${encodeURIComponent(this.target.id)}/flash`, body);
      if (epoch !== this.panelEpoch) return;
      $("pico-panel-status").textContent = "";
      this.showRun(run);
      this.poll(epoch);
    } catch (error) {
      if (epoch === this.panelEpoch) $("pico-panel-status").textContent = error.message;
    } finally {
      this.submitting = false;
      if (epoch === this.panelEpoch) this.controls();
    }
  }

  poll(epoch) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (epoch !== this.panelEpoch || !this.run || !this.signedIn) return;
      try {
        const { run } = await this.api(`/api/picos/runs/${encodeURIComponent(this.run.id)}`);
        if (epoch !== this.panelEpoch) return;
        this.showRun(run);
        if (active(run)) this.poll(epoch);
        else void this.refresh();
      } catch (error) {
        if (epoch === this.panelEpoch) {
          $("pico-panel-status").textContent = `${error.message}. Retrying status…`;
          this.poll(epoch);
        }
      }
    }, this.pollMilliseconds);
  }
}

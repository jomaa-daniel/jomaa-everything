import { $, api, element, notify } from "/home/accounts.js";
const players = new Map();
let timer = null;
let epoch = 0;
let view = "";
let recordingPlayer = null;
let historyEpoch = 0;
let historyBefore = null;
let olderBefore = null;
let historyItems = [];
let historyBusy = false;
function closeRecording() {
  recordingPlayer?.dispose();
  recordingPlayer = null;
  $("recording-video").replaceChildren();
  $("history-player").hidden = true;
}
function dispose() {
  for (const { player } of players.values()) player.dispose();
  players.clear();
  view = "";
  closeRecording();
}
function signedOut(message = "Sign in to view cameras.") {
  epoch++;
  clearInterval(timer);
  timer = null;
  dispose();
  historyEpoch++;
  historyBusy = false;
  historyBefore = null;
  historyItems = [];
  $("activity-list").replaceChildren();
  $("content").hidden = true;
  $("login-section").hidden = false;
  $("logout").hidden = true;
  $("refresh").hidden = true;
  notify(message);
}
function cameraCard(camera, playback) {
  const card = element("article", undefined, "camera-card");
  card.dataset.camera = camera.id;
  const heading = element("div", undefined, "camera-heading");
  const status = element("span", camera.configured ? "Connecting…" : "Not configured", "camera-status");
  status.setAttribute("role", "status");
  heading.append(element("h2", camera.name), status);
  const container = element("div", undefined, "camera-video");
  const video = element("video");
  video.className = "video-js vjs-default-skin";
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-label", `${camera.name} live video`);
  container.append(video);
  const placeholder = element("div", "No stream configured for this camera.", "camera-placeholder");
  container.hidden = !camera.configured;
  placeholder.hidden = camera.configured;
  const actions = element("div", undefined, "camera-actions");
  const retry = element("button", "Reconnect");
  retry.type = "button";
  retry.disabled = !camera.configured;
  retry.setAttribute("aria-label", `Reconnect ${camera.name}`);
  actions.append(retry);
  card.append(heading, container, placeholder, actions);
  $("camera-grid").append(card);
  if (camera.configured) {
    const player = videojs(video, {
      controls: true,
      autoplay: playback.autoplay ? "muted" : false,
      muted: playback.muted,
      preload: "none",
      html5: { vhs: { withCredentials: true } },
    });
    const connect = () => {
      status.textContent = "Connecting…";
      status.className = "camera-status";
      player.src({ src: camera.stream, type: "application/x-mpegURL" });
      if (playback.autoplay)
        player.play()?.catch(() => {
          status.textContent = "Ready · Press play";
        });
    };
    player.on("playing", () => {
      status.textContent = "Live";
      status.className = "camera-status live";
    });
    player.on("pause", () => {
      if (player.error()) return;
      status.textContent = "Paused";
      status.className = "camera-status";
    });
    player.on("error", () => {
      status.textContent = "Stream unavailable";
      status.className = "camera-status error";
    });
    retry.addEventListener("click", connect);
    players.set(camera.id, { player });
    connect();
  }
  return card;
}
async function refresh() {
  const current = epoch;
  try {
    const session = await api("/api/session");
    if (current !== epoch) return;
    if (!session.scopes.includes("cameras")) {
      signedOut("Your account does not have access to Cameras. Ask the hub owner to grant it.");
      return;
    }
    const inventory = await api("/api/cameras");
    if (current !== epoch) return;
    $("login-section").hidden = true;
    $("content").hidden = false;
    $("logout").hidden = false;
    $("refresh").hidden = false;
    $("setup-help").hidden = !session.owner || inventory.cameras.every((camera) => camera.configured);
    const signature = JSON.stringify(inventory);
    if (signature !== view) {
      dispose();
      $("camera-grid").replaceChildren();
      for (const camera of inventory.cameras) cameraCard(camera, inventory.playback);
      view = signature;
      $("history-camera").replaceChildren();
      for (const camera of inventory.cameras) {
        const option = element("option", camera.name);
        option.value = camera.id;
        $("history-camera").append(option);
      }
      $("history-section").hidden = !inventory.monitoring?.enabled;
      if (inventory.monitoring) {
        $("recording-length").max = inventory.monitoring.maxClipSeconds;
        $("recording-length").value = inventory.monitoring.maxClipSeconds;
      }
      historyBefore = null;
    }
    if (!$("history-section").hidden && !historyBusy) await refreshHistory();
    if (!timer) timer = setInterval(refresh, inventory.playback.refreshSeconds * 1000);
    notify("");
  } catch (error) {
    if (current !== epoch) return;
    if (error.status === 401 || error.status === 403) signedOut(error.message);
    else notify(error.message);
  }
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const username = $("username").value.trim();
    await api("/api/login", "POST", { password: $("password").value, ...(username ? { username } : {}) });
    epoch++;
    await refresh();
  } catch (error) {
    notify(error.message);
  } finally {
    $("password").value = "";
    button.disabled = false;
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", "POST", {});
    signedOut();
  } catch (error) {
    notify(error.message);
  }
});
function playRecording(src, title) {
  closeRecording();
  $("history-player").hidden = false;
  $("recording-title").textContent = title;
  $("recording-notice").textContent = "Loading recording…";
  const video = element("video");
  video.className = "video-js vjs-default-skin";
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-label", title);
  $("recording-video").append(video);
  recordingPlayer = videojs(video, { controls: true, autoplay: false, muted: true, preload: "metadata" });
  recordingPlayer.on("loadedmetadata", () => {
    $("recording-notice").textContent = "";
  });
  recordingPlayer.on("error", () => {
    $("recording-notice").textContent =
      "Recording unavailable. It may have expired or this time may have no retained footage.";
  });
  recordingPlayer.src({ src, type: "video/mp4" });
  $("history-player").scrollIntoView({ block: "nearest" });
}
function renderHistory() {
  $("activity-list").replaceChildren();
  const kind = $("history-kind").value;
  const items = historyItems.filter((item) => kind === "all" || item.kind === kind);
  for (const item of items) {
    const row = element("li", undefined, "activity-item");
    if (item.snapshot) {
      const image = element("img", undefined, "activity-image");
      image.src = item.snapshot;
      image.alt = `${item.label} at ${new Date(item.start * 1000).toLocaleString()}`;
      image.loading = "lazy";
      image.addEventListener("error", () => {
        image.hidden = true;
      });
      row.append(image);
    }
    const info = element("div", undefined, "activity-info");
    info.append(element("h3", item.label));
    const date = element("time", new Date(item.start * 1000).toLocaleString());
    date.dateTime = new Date(item.start * 1000).toISOString();
    info.append(date);
    if (item.end === null) info.append(element("p", "In progress", "muted"));
    const actions = element("div", undefined, "activity-actions");
    if (item.clip) {
      const button = element("button", `Play ${Math.ceil(item.clipSeconds)}s clip`);
      button.type = "button";
      button.addEventListener("click", () => playRecording(item.clip, `${item.label} · ${date.textContent}`));
      actions.append(button);
    }
    if (item.snapshot) {
      const link = element("a", "Snapshot");
      link.href = item.snapshot;
      link.target = "_blank";
      link.rel = "noopener";
      actions.append(link);
    }
    row.append(info, actions);
    $("activity-list").append(row);
  }
  if (historyItems.length && !items.length) $("history-notice").textContent = "No matching activity in this page.";
}
async function refreshHistory() {
  const current = ++historyEpoch;
  const sessionEpoch = epoch;
  historyBusy = true;
  try {
    const query = historyBefore === null ? "" : `?before=${encodeURIComponent(historyBefore)}`;
    const result = await api(`/api/cameras/${encodeURIComponent($("history-camera").value)}/history${query}`);
    if (current !== historyEpoch || sessionEpoch !== epoch) return;
    historyItems = result.items;
    olderBefore = result.before;
    $("history-notice").textContent =
      result.state === "unconfigured"
        ? "Connect this camera to see motion and recordings."
        : result.state === "disabled"
          ? "Motion detection and recording are disabled for this camera."
          : result.items.length
            ? "Motion and detected objects. Clips show retained footage; snapshots may expire."
            : "No recorded activity in this time window.";
    $("history-older").hidden = result.state !== "ready" || olderBefore === null || olderBefore <= 0;
    $("history-latest").hidden = historyBefore === null;
    renderHistory();
  } catch (error) {
    if (current !== historyEpoch || sessionEpoch !== epoch) return;
    if (error.status === 401 || error.status === 403) signedOut(error.message);
    else {
      $("history-notice").textContent = error.message;
      $("activity-list").replaceChildren();
      historyItems = [];
      $("history-older").hidden = true;
    }
  } finally {
    if (current === historyEpoch) historyBusy = false;
  }
}
$("history-camera").addEventListener("change", () => {
  historyBefore = null;
  closeRecording();
  refreshHistory();
});
$("history-kind").addEventListener("change", renderHistory);
$("history-older").addEventListener("click", () => {
  historyBefore = olderBefore;
  refreshHistory();
});
$("history-latest").addEventListener("click", () => {
  historyBefore = null;
  refreshHistory();
});
$("close-recording").addEventListener("click", closeRecording);
$("recording-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const start = new Date($("recording-start").value).getTime() / 1000;
  const duration = Number($("recording-length").value);
  if (!Number.isFinite(start) || start + duration > Date.now() / 1000) {
    $("history-notice").textContent = "Choose a recording time in the past.";
    return;
  }
  const camera = encodeURIComponent($("history-camera").value);
  playRecording(
    `/api/cameras/${camera}/recordings/${start}/${start + duration}/clip.mp4`,
    `Recording · ${new Date(start * 1000).toLocaleString()}`,
  );
});
$("refresh").addEventListener("click", refresh);
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  dispose();
});
refresh();

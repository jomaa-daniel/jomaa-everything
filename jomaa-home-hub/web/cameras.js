import { $, api, element, notify } from "/home/accounts.js";
const players = new Map();
let timer = null;
let epoch = 0;
let view = "";
function dispose() {
  for (const { player } of players.values()) player.dispose();
  players.clear();
  view = "";
}
function signedOut(message = "Sign in to view cameras.") {
  epoch++;
  clearInterval(timer);
  timer = null;
  dispose();
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
    }
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
$("refresh").addEventListener("click", refresh);
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  dispose();
});
refresh();

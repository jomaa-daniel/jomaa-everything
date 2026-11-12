import { $, api, ApiError, notify } from "/home/accounts.js";

const storageKey = "jomaa-invite";

/** The invite token from the link's fragment, kept for this tab and removed from the address bar. */
function inviteToken() {
  const fromLink = location.hash.slice(1);
  if (fromLink) {
    sessionStorage.setItem(storageKey, fromLink);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem(storageKey) ?? "";
}

function invalid() {
  sessionStorage.removeItem(storageKey);
  $("join-form").hidden = true;
  $("invalid").hidden = false;
}

const token = inviteToken();

async function start() {
  if (!token) return invalid();
  try {
    await api("/api/invites/check", "POST", { token });
    $("join-form").hidden = false;
    $("username").focus();
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) invalid();
    else notify(reason.message);
  }
}

$("username").addEventListener("input", () => {
  $("username").value = $("username").value.toLowerCase();
});
$("confirm").addEventListener("input", () => $("confirm").setCustomValidity(""));

$("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("password").value !== $("confirm").value) {
    $("confirm").setCustomValidity("Passwords don't match.");
    $("confirm").reportValidity();
    return;
  }
  const button = event.submitter;
  button.disabled = true;
  try {
    const { account } = await api("/api/join", "POST", {
      token,
      username: $("username").value,
      password: $("password").value,
    });
    sessionStorage.removeItem(storageKey);
    $("join-form").hidden = true;
    $("done-username").textContent = account.username;
    $("done").hidden = false;
    notify("");
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) invalid();
    notify(reason.message);
  } finally {
    button.disabled = false;
  }
});

start();

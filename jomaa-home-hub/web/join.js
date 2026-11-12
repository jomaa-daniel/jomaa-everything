import { $, api, ApiError, notify, when } from "/home/accounts.js";

const steps = ["username", "password", "done"];
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

function show(step) {
  $("checking").hidden = true;
  $("invalid").hidden = step !== "invalid";
  $("steps").hidden = step === "invalid";
  for (const name of steps) $("step-" + name).hidden = name !== step;
  const current = steps.indexOf(step);
  for (const item of $("steps").children) {
    const index = steps.indexOf(item.dataset.step);
    item.classList.toggle("done", index < current);
    if (index === current) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
}

const token = inviteToken();

async function start() {
  if (!token) {
    show("invalid");
    return;
  }
  try {
    const { expiresAt } = await api("/api/invites/check", "POST", { token });
    $("invite-expires").textContent = `This invite expires ${when(expiresAt)}.`;
    show("username");
    $("username").focus();
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) {
      sessionStorage.removeItem(storageKey);
      show("invalid");
    } else {
      $("checking").hidden = true;
      notify(reason.message);
    }
  }
}

$("step-username").addEventListener("submit", (event) => {
  event.preventDefault();
  const username = $("username").value.trim().toLowerCase();
  $("username").value = username;
  $("chosen-username").textContent = username;
  $("password-username").value = username;
  notify("");
  show("password");
  $("password").focus();
});

$("back").addEventListener("click", () => {
  notify("");
  show("username");
  $("username").focus();
});

$("confirm").addEventListener("input", () => $("confirm").setCustomValidity(""));

$("step-password").addEventListener("submit", async (event) => {
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
    $("password").value = "";
    $("confirm").value = "";
    $("done-username").textContent = account.username;
    notify("");
    show("done");
  } catch (reason) {
    notify(reason.message);
    if (reason instanceof ApiError && reason.status === 404) {
      sessionStorage.removeItem(storageKey);
      show("invalid");
    } else if (reason instanceof ApiError && (reason.status === 409 || /username/i.test(reason.message))) {
      show("username");
      $("username").focus();
    }
  } finally {
    button.disabled = false;
  }
});

start();

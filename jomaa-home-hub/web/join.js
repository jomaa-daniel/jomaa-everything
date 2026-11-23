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
    const { passwordLength } = await api("/api/invites/check", "POST", { token });
    $("password-min").textContent = passwordLength.min;
    $("password").minLength = passwordLength.min;
    $("password").maxLength = passwordLength.max;
    $("join-form").hidden = false;
    $("username").focus();
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) invalid();
    else notify(reason.message);
  }
}

window.addEventListener("hashchange", () => location.reload());

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
    const password = $("password").value;
    const { account, destinations } = await api("/api/join", "POST", {
      token,
      username: $("username").value,
      password,
    });
    sessionStorage.removeItem(storageKey);
    $("join-form").hidden = true;
    $("password").value = "";
    $("confirm").value = "";
    $("done-username").textContent = account.username;
    $("join-title").textContent = "Account created";
    $("join-next").textContent = destinations.length
      ? `Choose where to sign in as ${account.username}.`
      : "Your account has no home access yet. Ask the hub owner to grant access.";
    const credentials = { username: account.username, password };
    const choices = destinations.map((destination) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = `Sign in to ${destination.name}`;
      choice.className = "primary-action";
      choice.addEventListener("click", async () => {
        for (const action of choices) action.disabled = true;
        try {
          await api("/api/login", "POST", credentials);
          credentials.password = "";
          location.replace(destination.href);
        } catch (reason) {
          notify(reason.message);
          for (const action of choices) action.disabled = false;
        }
      });
      return choice;
    });
    $("join-destinations").replaceChildren(...choices);
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

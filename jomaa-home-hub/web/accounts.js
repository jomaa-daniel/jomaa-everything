export const $ = (id) => document.getElementById(id);

/** An API failure with the hub's message and HTTP status. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let signedOut = () => {};

/** Sends a JSON request; a 401 outside sign-in shows the page's signed-out state. */
export async function api(path, method = "GET", data) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/login") signedOut();
  if (!response.ok) throw new ApiError(response.status, body.error || `Request failed (HTTP ${response.status})`);
  return body;
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function notify(text, success = false) {
  $("notice").className = success ? "success" : "";
  $("notice").textContent = text;
}

export function when(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Runs an owner-only page: the hub password sign-in when signed out, a notice
 * for accounts, and load for the owner. Returns the function that starts it.
 */
export function ownerPage(load) {
  const show = (state) => {
    $("login-section").hidden = state !== "signed-out";
    $("not-owner").hidden = state !== "not-owner";
    $("content").hidden = state !== "owner";
    $("logout").hidden = state === "signed-out";
  };
  signedOut = () => show("signed-out");
  const start = async () => {
    try {
      const session = await api("/api/session");
      if (!session.owner) {
        show("not-owner");
        return;
      }
      show("owner");
      await load();
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 401)) notify(reason.message);
    }
  };
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      await api("/api/login", "POST", { password: $("password").value });
      notify("");
      await start();
    } catch (reason) {
      notify(reason.message);
    } finally {
      $("password").value = "";
      button.disabled = false;
    }
  });
  $("logout").addEventListener("click", async () => {
    try {
      await api("/api/logout", "POST", {});
      notify("");
      show("signed-out");
    } catch (reason) {
      notify(reason.message);
    }
  });
  return start;
}

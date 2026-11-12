import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

async function load() {
  const { invites } = await api("/api/invites");
  $("invites").replaceChildren(
    ...invites.map((invite) => {
      const row = element("li");
      const text = element("div");
      text.append(
        element("strong", `Created ${when(invite.createdAt)}`),
        element("span", ` · expires ${when(invite.expiresAt)}`),
      );
      const revoke = element("button", "Revoke", "danger");
      revoke.setAttribute("aria-label", `Revoke invite created ${when(invite.createdAt)}`);
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api(`/api/invites/${encodeURIComponent(invite.id)}`, "DELETE");
          notify("Invite revoked. Its link no longer works.", true);
          await load();
        } catch (reason) {
          notify(reason.message);
          revoke.disabled = false;
        }
      });
      row.append(text, revoke);
      return row;
    }),
  );
  $("invites-empty").hidden = invites.length > 0;
}

const start = ownerPage(load);

$("create").addEventListener("click", async () => {
  $("create").disabled = true;
  try {
    const { invite, token } = await api("/api/invites", "POST", {});
    $("link").value = `${location.origin}/join#${token}`;
    $("link-expires").textContent = when(invite.expiresAt);
    $("created").hidden = false;
    $("share").hidden = typeof navigator.share !== "function";
    $("link").focus();
    $("link").select();
    notify("");
    await load();
  } catch (reason) {
    notify(reason.message);
  } finally {
    $("create").disabled = false;
  }
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("link").value);
    notify("Link copied.", true);
  } catch {
    $("link").select();
    notify("Copy failed. Select the link and copy it manually.");
  }
});

$("share").addEventListener("click", async () => {
  try {
    await navigator.share({ title: "Jomaa Home invite", url: $("link").value });
  } catch (reason) {
    if (reason.name !== "AbortError") notify("Sharing failed. Copy the link instead.");
  }
});

start();

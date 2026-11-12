import { $, api, element, notify, ownerPage, when } from "/home/accounts.js";

async function load() {
  const { invites } = await api("/api/invites");
  $("invites").replaceChildren(
    ...invites.map((invite) => {
      const row = element("li");
      const label = element("span", `Created ${when(invite.createdAt)}, expires ${when(invite.expiresAt)}`);
      const revoke = element("button", "Revoke", "danger");
      revoke.setAttribute("aria-label", `Revoke invite created ${when(invite.createdAt)}`);
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api(`/api/invites/${encodeURIComponent(invite.id)}`, "DELETE");
          notify("Invite revoked.", true);
          await load();
        } catch (reason) {
          notify(reason.message);
          revoke.disabled = false;
        }
      });
      row.append(label, revoke);
      return row;
    }),
  );
  $("invites-empty").hidden = invites.length > 0;
}

$("create").addEventListener("click", async () => {
  $("create").disabled = true;
  try {
    const { invite, token } = await api("/api/invites", "POST", {});
    $("link").value = `${location.origin}/join#${token}`;
    $("copy").disabled = false;
    $("link").select();
    notify(`Link created; it expires ${when(invite.expiresAt)} and is shown only once.`, true);
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
    notify("Copy failed. Select the link and copy it.");
  }
});

ownerPage(load)();

/** Applies the page's selected installation to an API request. */
export function nodeURL(path) {
  const selected = new URL(location.href).searchParams.get("node");
  if (selected === null) return path;
  const url = new URL(path, location.origin);
  url.searchParams.set("node", selected);
  return url.pathname + url.search;
}

/** Lists installations granting any of the page's capabilities. Selection reloads the page. */
export async function refreshNodePicker(scopes) {
  const container = document.getElementById("node-picker");
  if (!container) return;
  const response = await fetch("/api/nodes", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    container.replaceChildren();
    return;
  }
  const { nodes, routing } = await response.json();
  if (scopes.every((scope) => routing[scope] === "account")) {
    container.replaceChildren();
    return;
  }
  const available = nodes.filter((node) => scopes.some((scope) => node.scopes.includes(scope)));
  if (available.length === 0) {
    container.replaceChildren();
    return;
  }
  const label = document.createElement("label");
  label.textContent = "Home ";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Home");
  for (const node of available) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.name;
    select.append(option);
  }
  const selected = new URL(location.href).searchParams.get("node");
  if (selected !== null && !available.some((node) => node.id === selected)) {
    const unavailable = document.createElement("option");
    unavailable.value = "";
    unavailable.textContent = "Choose an available home";
    unavailable.disabled = true;
    unavailable.selected = true;
    select.prepend(unavailable);
  } else if (selected !== null) select.value = selected;
  else if (available.length) {
    const url = new URL(location.href);
    url.searchParams.set("node", available[0].id);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  select.addEventListener("change", () => {
    const url = new URL(location.href);
    url.searchParams.set("node", select.value);
    location.assign(url.pathname + url.search + url.hash);
  });
  label.append(select);
  container.replaceChildren(label);
}

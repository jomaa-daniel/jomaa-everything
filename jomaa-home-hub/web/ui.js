export const sessionEndEvent = "hub-session-end";
const interactive = 'a[href], button, input, select, textarea, [tabindex="0"]';
const nativeArrows =
  'textarea, select, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"], [data-native-arrows]';
let lastFocus = null;

function visible(element) {
  return (
    !element.matches(":disabled, [aria-disabled='true']") &&
    !element.closest("[hidden], [inert]") &&
    element.getClientRects().length > 0
  );
}
function controls(root) {
  return [...root.querySelectorAll(interactive)].filter(visible);
}
function dialogScope() {
  return document.querySelector("dialog[open]") || document;
}
function groupFor(target) {
  return target.closest(
    "[data-tui-nav], .management-list, .group-options, .dialog-actions, .swatches, #color-grid, tbody",
  );
}
function focusKey(element) {
  return element.id || element.getAttribute("aria-label") || element.dataset.tab || element.textContent.trim();
}
function prepareGroups() {
  if (lastFocus?.element.matches(":disabled")) lastFocus.restorePending = true;
  for (const group of document.querySelectorAll("[data-tui-nav]")) {
    if (group.closest("[data-own-arrows]")) continue;
    const items = controls(group);
    const chosen = items.includes(document.activeElement)
      ? document.activeElement
      : items.find(
          (item) =>
            item.hasAttribute("aria-current") ||
            item.getAttribute("aria-selected") === "true" ||
            item.getAttribute("aria-pressed") === "true",
        ) || items[0];
    for (const item of items) item.tabIndex = item === chosen ? 0 : -1;
  }
  if (
    lastFocus &&
    (!lastFocus.element.isConnected || (lastFocus.restorePending && visible(lastFocus.element))) &&
    document.activeElement === document.body
  ) {
    const root = lastFocus.root.isConnected ? lastFocus.root : dialogScope();
    const items = controls(root);
    const restored =
      items.find((item) => focusKey(item) === lastFocus.key) || items[Math.min(lastFocus.index, items.length - 1)];
    restored?.focus({ preventScroll: true });
  }
}

export function updateUIHints() {
  const target = document.activeElement;
  let hints;
  if (target.matches("[data-native-arrows]"))
    hints = [
      ["↑↓", "Scroll"],
      ["PageUp/Down", "Pages"],
      ["Tab", "Next"],
    ];
  else if (target.matches("select, input[type='range'], input[type='number']"))
    hints = [
      ["Arrows", "Adjust"],
      ["Alt+↑↓", "Fields"],
      ["Tab", "Next"],
    ];
  else if (target.matches(nativeArrows))
    hints = [
      ["←→", "Edit"],
      ["Alt+↑↓", "Fields"],
      ["Tab", "Next"],
    ];
  else if (target.closest("tbody"))
    hints = [
      ["↑↓", "Rows"],
      ["←→", "Actions"],
      [target.type === "checkbox" ? "Space" : "Enter", target.type === "checkbox" ? "Toggle" : "Activate"],
    ];
  else if (target.closest("[data-tui-nav], .management-list, .swatches, #color-grid"))
    hints = [
      ["↑↓←→", "Navigate"],
      ["Enter", "Activate"],
      ["Tab", "Next panel"],
    ];
  else if (target.type === "checkbox" || target.type === "radio")
    hints = [
      ["↑↓", "Options"],
      ["Space", "Toggle"],
      ["Tab", "Next"],
    ];
  else
    hints = [
      ["↑↓←→", "Navigate"],
      ["Enter", "Activate"],
      ["Tab", "Next"],
    ];
  if (target.closest("dialog")) hints.push(["Esc", "Close"]);
  const box = document.getElementById("command-hints");
  if (!box) return;
  box.replaceChildren();
  for (const [key, label] of hints) {
    const span = document.createElement("span");
    span.className = "key-command";
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    const text = document.createElement("span");
    text.textContent = label;
    span.append(kbd, text);
    box.append(span);
  }
}

function navigate(event) {
  if (
    event.defaultPrevented ||
    !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  const target = event.target;
  if (event.altKey && !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  if (!event.altKey && (target.matches(nativeArrows) || target.closest("[data-own-arrows]"))) return;
  const scope = dialogScope();
  let group = event.altKey ? target.closest("dialog[open], form, section") || scope : groupFor(target);
  if (!group) group = target.closest("form, section, header, nav") || scope;
  let items = controls(group);
  if (!items.includes(target)) return;
  let next;
  const index = items.indexOf(target);
  if (event.key === "Home") next = items[0];
  else if (event.key === "End") next = items.at(-1);
  else if (
    event.altKey ||
    group.dataset?.tuiNav === "vertical" ||
    (target.type === "checkbox" && group.matches(".group-options"))
  ) {
    const offset = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
    next = items[Math.max(0, Math.min(items.length - 1, index + offset))];
  } else if (group.tagName === "TBODY") {
    const rows = [...group.rows];
    const row = target.closest("tr");
    const rowItems = controls(row);
    const column = rowItems.indexOf(target);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      next = rowItems[Math.max(0, Math.min(rowItems.length - 1, column + (event.key === "ArrowRight" ? 1 : -1)))];
    else {
      const offset = event.key === "ArrowDown" ? 1 : -1;
      for (let i = rows.indexOf(row) + offset; i >= 0 && i < rows.length; i += offset) {
        const options = controls(rows[i]);
        if (options.length) {
          next = options[Math.min(column, options.length - 1)];
          break;
        }
      }
    }
  } else {
    const start = target.getBoundingClientRect();
    const x = start.x + start.width / 2,
      y = start.y + start.height / 2;
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const candidates = items
      .filter((item) => item !== target)
      .map((item) => {
        const rect = item.getBoundingClientRect();
        const dx = rect.x + rect.width / 2 - x,
          dy = rect.y + rect.height / 2 - y;
        return { item, primary: vertical ? dy : dx, secondary: vertical ? dx : dy };
      })
      .filter((item) => item.primary * direction > 1)
      .sort((a, b) => Math.abs(a.primary) - Math.abs(b.primary) || Math.abs(a.secondary) - Math.abs(b.secondary));
    const closest = candidates[0];
    if (closest)
      next = candidates
        .filter((item) => Math.abs(item.primary) <= Math.abs(closest.primary) + 1)
        .sort((a, b) => Math.abs(a.secondary) - Math.abs(b.secondary))[0].item;
    if (!next && group.dataset?.tuiNav === "horizontal" && !vertical)
      next = items[Math.max(0, Math.min(items.length - 1, index + direction))];
  }
  event.preventDefault();
  if (next) {
    next.focus();
    prepareGroups();
  }
}

document.addEventListener("keydown", navigate);
document.addEventListener("focusin", (event) => {
  const root = groupFor(event.target) || event.target.closest("form, section, header") || document;
  lastFocus = {
    element: event.target,
    root,
    key: focusKey(event.target),
    index: controls(root).indexOf(event.target),
    restorePending: false,
  };
  prepareGroups();
  updateUIHints();
});
const observer = new MutationObserver((records) => {
  if (records.every((record) => record.target.closest?.(".command-bar"))) return;
  prepareGroups();
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["hidden", "disabled"],
});

const header = document.querySelector("body > header");
if (header) {
  const nav = document.createElement("nav");
  nav.className = "hub-nav";
  nav.setAttribute("aria-label", "Hub pages");
  nav.dataset.tuiNav = "horizontal";
  for (const [href, label] of [
    ["/home", "Home"],
    ["/manage", "Devices"],
    ["/lights", "Lights"],
    ["/permissions", "Accounts"],
    ["/invite", "Invites"],
    ["/secrets", "Secrets"],
  ]) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (location.pathname.replace(/\/$/, "") === href) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  header.insertBefore(nav, document.getElementById("logout"));
}
let footer = document.querySelector(".command-bar");
if (!footer) {
  footer = document.createElement("footer");
  footer.className = "command-bar";
  const content = document.createElement("div");
  content.className = "command-content";
  let notice = document.getElementById("notice");
  if (!notice) {
    notice = document.createElement("p");
    notice.id = "notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.textContent = "Ready.";
  }
  const hints = document.createElement("div");
  hints.id = "command-hints";
  hints.setAttribute("aria-label", "Keyboard commands");
  content.append(notice, hints);
  footer.append(content);
  document.body.append(footer);
}
prepareGroups();
updateUIHints();

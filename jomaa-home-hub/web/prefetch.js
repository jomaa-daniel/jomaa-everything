// Counts followed links to hub pages and, once the browser is idle, prefetches
// the linked pages the visitor can open with their files, most-clicked first.

/** The path of a same-origin link without a trailing slash, or null for other origins. */
function pagePath(anchor) {
  if (anchor.origin !== location.origin) return null;
  return anchor.pathname.replace(/(.)\/$/, "$1");
}

const here = location.pathname.replace(/(.)\/$/, "$1");

function countClick(event) {
  if (event.type === "auxclick" && event.button !== 1) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const path = anchor === null ? null : pagePath(anchor);
  if (path === null || path === here) return;
  fetch("/api/clicks", {
    method: "POST",
    keepalive: true,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }).catch(() => {});
}

const linkPrefetch = document.createElement("link").relList.supports("prefetch");

/** Fetches one URL into the browser cache at low priority; settles when it finishes or fails. */
function prefetch(url) {
  if (!linkPrefetch) {
    return fetch(url, { credentials: "same-origin", priority: "low" }).then(
      (response) => response.arrayBuffer(),
      () => {},
    );
  }
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url;
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
    document.head.append(link);
  });
}

async function prefetchLinkedPages() {
  if (navigator.connection?.saveData) return;
  const linked = new Set();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const path = pagePath(anchor);
    if (path !== null && path !== here) linked.add(path);
  }
  if (linked.size === 0) return;
  const response = await fetch("/api/prefetch", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return;
  const { concurrency, pages } = await response.json();
  const loaded = new Set([here]);
  for (const entry of performance.getEntriesByType("resource")) {
    const url = new URL(entry.name);
    if (url.origin === location.origin) loaded.add(url.pathname + url.search);
  }
  const queue = [];
  for (const page of pages) {
    if (!linked.has(page.path)) continue;
    for (const url of [page.path, ...page.assets]) {
      if (loaded.has(url)) continue;
      loaded.add(url);
      queue.push(url);
    }
  }
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) await prefetch(url);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

document.addEventListener("click", countClick);
document.addEventListener("auxclick", countClick);

const whenIdle = window.requestIdleCallback ?? ((callback) => setTimeout(callback, 0));
const start = () => whenIdle(() => prefetchLinkedPages().catch(() => {}));
if (document.readyState === "complete") start();
else addEventListener("load", start, { once: true });

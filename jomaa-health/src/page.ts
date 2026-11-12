import type { Report, Result, Status } from "./checks.ts";

const labels: Record<Status, string> = { ok: "Working", warn: "Degraded", fail: "Failing" };
const headlines: Record<Status, string> = {
  ok: "Everything on jomaa.org is reachable",
  warn: "jomaa.org is up; some devices are not answering",
  fail: "Part of jomaa.org is not working",
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function row(r: Result): string {
  return `<tr class="${r.status}">
  <td><span class="dot" aria-hidden="true"></span><span class="sr">${labels[r.status]}</span></td>
  <td><a href="${escape(r.url)}">${escape(r.name)}</a></td>
  <td>${escape(r.detail)}</td>
  <td class="ms">${r.ms} ms</td>
</tr>`;
}

/** The status page for one report. */
export function renderPage(report: Report, ttlSeconds: number): string {
  const groups = new Map<string, Result[]>();
  for (const r of report.results) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const counts = (status: Status) => report.results.filter((r) => r.status === status).length;
  const checked = new Date(report.checkedAt).toISOString().replace("T", " ").slice(0, 19);
  const sections = [...groups]
    .map(
      ([group, results]) => `<section>
<h2>${escape(group)}</h2>
<table>
<tbody>
${results.map(row).join("\n")}
</tbody>
</table>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${labels[report.status]} · jomaa.org health</title>
<style>
:root { color-scheme: light dark; --ok: #1a7f37; --warn: #b7791f; --fail: #cf222e; --muted: #6e7781; --line: #d0d7de55; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 60rem; padding: 2rem 1rem 4rem; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { display: flex; gap: 1rem; align-items: center; padding: 1.25rem; border-radius: 12px; color: #fff; background: var(--${report.status}); }
header h1 { margin: 0; font-size: 1.3rem; }
header p { margin: 0.2rem 0 0; opacity: 0.9; }
h2 { margin: 2rem 0 0.5rem; font-size: 1rem; }
table { width: 100%; border-collapse: collapse; }
td { padding: 0.45rem 0.5rem; border-top: 1px solid var(--line); vertical-align: top; }
td:first-child { width: 1.5rem; }
td:nth-child(2) { width: 34%; overflow-wrap: anywhere; }
td.ms { width: 5.5rem; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
a { color: inherit; }
.dot { display: inline-block; width: 0.7rem; height: 0.7rem; margin-top: 0.3rem; border-radius: 50%; }
.ok .dot { background: var(--ok); } .warn .dot { background: var(--warn); } .fail .dot { background: var(--fail); }
.warn td:nth-child(3) { color: var(--warn); } .fail td:nth-child(3) { color: var(--fail); font-weight: 600; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
footer { margin-top: 2rem; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<header>
<div>
<h1>${headlines[report.status]}</h1>
<p>${counts("ok")} working · ${counts("warn")} degraded · ${counts("fail")} failing</p>
</div>
</header>
${sections}
<footer>Checked ${checked} UTC from Cloudflare. Results are reused for ${ttlSeconds} s; reload after that to check again. Machine-readable: <a href="/checks.json">/checks.json</a>.</footer>
</body>
</html>
`;
}

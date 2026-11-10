import { cpSync } from "node:fs";

cpSync(new URL("../web", import.meta.url), new URL("../dist/web", import.meta.url), { recursive: true });

const panel = new URL("../../jomaa-static-pages/device-panel/", import.meta.url);
for (const [source, target] of [
  ["index.html", "lights.html"],
  ["app.js", "lights.js"],
  ["style.css", "lights.css"],
]) {
  cpSync(new URL(source, panel), new URL("../dist/web/" + target, import.meta.url));
}

import { join } from "node:path";
import type { Page } from "playwright-core";

/** Captures desktop and phone views of a test page when screenshot output is requested. */
export async function captureReviewScreenshots(page: Page, name: string): Promise<void> {
  const directory = process.env["JOMAA_UI_SCREENSHOTS"];
  if (!directory) return;
  const original = page.viewportSize();
  try {
    for (const [size, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(directory, `ui-${name}-${size}.png`), fullPage: true });
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
}

export function isFocused(element: { matches(selector: string): boolean }): boolean {
  return element.matches(":focus");
}

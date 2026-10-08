// One-off dev script: renders the viewer logo to the PNG sizes the manifest needs.
// Run: node scripts/make-icons.mjs   (needs Playwright's Chromium)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(path.join(root, "../viewer/public/logo.svg"), "utf8");
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: path.join(root, `public/icons/icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("icons written");

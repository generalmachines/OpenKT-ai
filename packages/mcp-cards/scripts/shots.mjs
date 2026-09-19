// Screenshots + an end-to-end check of the three views in the fake host (preview.html).
// Uses an already-installed Playwright + Chromium; never downloads a browser.
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright  CHROME_BIN=/path/to/chrome  node scripts/shots.mjs
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { serve } from "./serve.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const executablePath = process.env.CHROME_BIN || join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell");

const { server, url } = await serve(0);
const browser = await chromium.launch({ executablePath });
await mkdir(join(pkg, "screenshots"), { recursive: true });
const problems = [];

async function open(view, theme, width, extra = "") {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${view}/${theme}/${width}: console ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${view}/${theme}/${width}: ${e.message}`));
  await page.goto(`${url}/preview.html?bare&view=${view}&theme=${theme}&width=${width}${extra}`);
  const card = page.frameLocator("#frame");
  await card.locator('#root[aria-busy="false"]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(250); // let size-changed settle
  return { page, card };
}

for (const view of ["save", "results", "session"]) {
  for (const theme of ["light", "dark"]) {
    for (const width of [380, 640]) {
      const { page, card } = await open(view, theme, width);
      const overflow = await card.locator("body").evaluate((b) => b.scrollWidth - b.clientWidth);
      if (overflow > 0) problems.push(`${view}/${theme}/${width}: horizontal overflow ${overflow}px`);
      await page.locator("#chat").screenshot({ path: join(pkg, "screenshots", `${view}-${theme}-${width}.png`) });
      await page.close();
    }
  }
}

// Very narrow hosts: no screenshot, just make sure nothing overflows.
for (const view of ["save", "results", "session", "resultsMixed"]) {
  const { page, card } = await open(view, "light", 320);
  const overflow = await card.locator("body").evaluate((b) => b.scrollWidth - b.clientWidth);
  if (overflow > 0) problems.push(`${view}/320: horizontal overflow ${overflow}px`);
  await page.close();
}

// Extra states worth looking at.
{
  const { page, card } = await open("save", "light", 380);
  await card.getByText("Another space…").click();
  await page.waitForTimeout(250);
  await page.locator("#chat").screenshot({ path: join(pkg, "screenshots", "save-expanded-light-380.png") });
  await card.getByRole("radio", { name: /eng \/ platform/ }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByText("saved to eng / platform").waitFor({ timeout: 5000 });
  const log = await page.evaluate(() => window.__hostLog);
  const call = log.find((m) => m.method === "tools/call");
  assert.equal(call.params.name, "kt_commit_save");
  assert.deepEqual(Object.keys(call.params.arguments).sort(), ["content", "draft_id", "kind", "project", "session_id", "visibility"]);
  assert.equal(call.params.arguments.visibility, "project");
  assert.ok(log.some((m) => m.method === "ui/update-model-context" && /Do not save it again/.test(m.params.content[0].text)));
  await page.waitForTimeout(200);
  await page.locator("#chat").screenshot({ path: join(pkg, "screenshots", "save-done-light-380.png") });
  await page.close();
}
{
  const { page, card } = await open("save", "dark", 640);
  await card.getByRole("radio", { name: /Only me/ }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByText("saved to your personal space").waitFor({ timeout: 5000 });
  const call = (await page.evaluate(() => window.__hostLog)).find((m) => m.method === "tools/call");
  assert.equal(call.params.arguments.visibility, "personal");
  assert.equal("project" in call.params.arguments, false);
  await page.close();
}
{
  const { page, card } = await open("save", "light", 640, "&host=fail");
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByRole("alert").waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
  await page.locator("#chat").screenshot({ path: join(pkg, "screenshots", "save-error-light-640.png") });
  await page.close();
}
{
  const { page, card } = await open("results", "light", 640);
  await card.getByRole("button", { name: /Quote Northgate/ }).click();
  await card.getByRole("button", { name: /Procurement needs/ }).click();
  await card.getByText("2 added to this conversation").waitFor({ timeout: 5000 });
  const updates = (await page.evaluate(() => window.__hostLog)).filter((m) => m.method === "ui/update-model-context");
  assert.equal(updates.length, 2);
  assert.match(updates[1].params.content[0].text, /Quote Northgate[\s\S]*Procurement needs/); // cumulative: each update replaces the last
  await page.waitForTimeout(200);
  await page.locator("#chat").screenshot({ path: join(pkg, "screenshots", "results-pinned-light-640.png") });
  await page.close();
}
for (const [view, theme, width] of [["resultsMixed", "dark", 380], ["resultsEmpty", "light", 380], ["saveFew", "light", 380]]) {
  const { page } = await open(view, theme, width);
  await page.locator("#chat").screenshot({ path: join(pkg, "screenshots", `${view}-${theme}-${width}.png`) });
  await page.close();
}

await browser.close();
server.close();
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("screenshots written to packages/mcp-cards/screenshots · e2e assertions passed · no console errors, CSP violations or horizontal overflow");

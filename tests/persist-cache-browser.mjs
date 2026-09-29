/** Real-browser check that the query cache persists and restores across a
 * reload (targeted PersistProvider). Needs a running isolated server:
 *   BASE=http://127.0.0.1:3217 node tests/persist-cache-browser.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3217";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  // securityNames is persisted; the save is throttled by 2 s.
  await page.waitForTimeout(6000);
  const stored = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open("guanlan-query-cache");
          open.onsuccess = () => {
            const get = open.result
              .transaction("queries")
              .objectStore("queries")
              .get("trpc");
            get.onsuccess = () => resolve(get.result ?? null);
          };
        }),
    );
  const first = await stored();
  assert.ok(first, "persisted cache written");
  const names = JSON.parse(first).json.clientState.queries.map(
    (q) => q.queryKey[0][0],
  );
  assert.ok(names.includes("securityNames"), names.join());
  assert.ok(!names.includes("deliveries"), "polled queries are not persisted");
  // Reload with the API blocked: restoring (library persistQueryClientRestore)
  // must not trigger a write when no persisted query received new data.
  await page.route("**/api/trpc/**", (route) => route.abort());
  await page.reload();
  await page.waitForTimeout(1500);
  const after = await stored();
  assert.equal(after, first, "no write without new persisted data");
  console.log(JSON.stringify({ ok: true, persisted: names }));
} finally {
  await browser.close();
}

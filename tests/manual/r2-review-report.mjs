import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import Database from "better-sqlite3";
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("next/package.json"))("sharp");
const destination = resolve("docs/review/r2-review");
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/r2/browser"),
);
const pages = {
  connections: ["workbench/connections", "notification-policy-fields"],
  signals: ["workbench/signals-view"],
  "trade-ledger": ["trade-ledger-panel"],
  "signal-ledger": ["signal-ledger-view"],
  screen: ["workbench/screen-view", "formula-screen", "online-screen"],
  market: [
    "workbench/market-view",
    "chart-workspace",
    "chart",
    "security-select",
  ],
};
const comparisons = [],
  interactions = {};
for (const [page, files] of Object.entries(pages)) {
  const replaced = Object.fromEntries(
    ["input", "select", "textarea", "table", "button"].map((tag) => [tag, 0]),
  );
  const retained = { ...replaced };
  for (const name of files) {
    const file = `src/components/${name}.tsx`;
    const before = execFileSync("git", ["show", `4725e40:${file}`], {
      encoding: "utf8",
    });
    const after = await readFile(file, "utf8");
    for (const tag of Object.keys(replaced)) {
      const count = (source) =>
        (source.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
      replaced[tag] += count(before) - count(after);
      retained[tag] += count(after);
    }
  }
  const before = await sharp(`${destination}/${page}/before.png`)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const after = await sharp(`${destination}/${page}/after.png`)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Math.min(before.info.width, after.info.width),
    height = Math.min(before.info.height, after.info.height);
  let changedOverlapPixels = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = (y * before.info.width + x) * 4,
        b = (y * after.info.width + x) * 4;
      if (!before.data.subarray(a, a + 4).equals(after.data.subarray(b, b + 4)))
        changedOverlapPixels++;
    }
  const old = JSON.parse(
    await readFile(`${destination}/${page}/before.json`, "utf8"),
  );
  const current = JSON.parse(
    await readFile(`${destination}/${page}/after.json`, "utf8"),
  );
  assert.deepEqual(current.errors, []);
  assert.ok(current.interactions.length > 0);
  const dimensions = (image) => ({
    width: image.info.width,
    height: image.info.height,
  });
  const controls = current.controls.flatMap((control) => {
    if (!control.label || !["INPUT", "TEXTAREA"].includes(control.tag))
      return [];
    const previous = old.controls.find(
      (item) => item.tag === control.tag && item.label === control.label,
    );
    if (!previous) return [];
    const changed = {};
    for (const key of [
      "width",
      "height",
      "font",
      "background",
      "border",
      "padding",
      "radius",
    ])
      if (previous[key] !== control[key])
        changed[key] = { before: previous[key], after: control[key] };
    return Object.keys(changed).length
      ? [{ label: control.label, changed }]
      : [];
  });
  comparisons.push({
    page,
    replaced,
    retainedInListedFiles: retained,
    before: dimensions(before),
    after: dimensions(after),
    changedOverlapPixels,
    extraHeightPixels: Math.abs(after.info.height - before.info.height) * width,
    controls,
  });
  interactions[page] = {
    checks: current.interactions,
    browserErrors: current.errors,
    blockedBrowserExternalRequests: current.requests,
    dialogs: "原页面未使用dialog；保留的details按适用页面验证",
    switches: "原页面使用checkbox，未引入新Switch行为",
  };
}
const db = new Database(resolve(process.env.QUANT_DATA_DIR, "quant.sqlite"), {
  readonly: true,
});
const counts = db
  .prepare(
    "SELECT kind,count(*) AS count FROM records WHERE kind IN ('channel','delivery') GROUP BY kind",
  )
  .all();
const attempts = db
  .prepare(
    "SELECT coalesce(sum(json_extract(payload,'$.attempts')),0) AS count FROM records WHERE kind='delivery'",
  )
  .get().count;
db.close();
assert.deepEqual(counts, []);
assert.equal(attempts, 0);
await writeFile(
  `${destination}/comparison.json`,
  JSON.stringify(comparisons, null, 2) + "\n",
);
await writeFile(
  `${destination}/interactions.json`,
  JSON.stringify(
    {
      pages: interactions,
      notificationAudit: {
        dataDirectory: ".test-data/r2/browser",
        configuredChannelRows: 0,
        deliveryRows: 0,
        deliveryAttempts: attempts,
        actualNetworkDeliveries: 0,
        basis:
          "隔离库只读查询channel/delivery均无记录；所有订阅提交channels=[]；未调用测试通知或手动重发；受限网络环境",
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    comparisons.map(
      ({ page, replaced, before, after, changedOverlapPixels }) => ({
        page,
        replaced,
        before,
        after,
        changedOverlapPixels,
      }),
    ),
    null,
    2,
  ),
);

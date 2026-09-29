/** Browser baseline/acceptance against an explicitly isolated production server. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const data = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(data.startsWith(resolve(tmpdir()) + "\\quant-research-archive-"));
const base = process.env.BASE ?? "http://127.0.0.1:3220";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const phase = process.env.ARCHIVE_PHASE ?? "before";
const dir = join(tmpdir(), "logs", "quant-research-archive");
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(base + "/reports");
  await page
    .getByRole("heading", {
      name: phase === "before" ? "通用研究报告" : "研究报告",
      exact: true,
    })
    .waitFor();
  const db = new Database(join(data, "quant.sqlite"));
  db.pragma("busy_timeout=5000");
  const insert = db.prepare(
    "INSERT OR REPLACE INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
  );
  insert.run(
    "archive-source",
    "snapshot",
    JSON.stringify({ symbol: "sh600519", name: "归档名称" }),
    1,
  );
  for (let i = 0; i < 125; i++) {
    const id = `report-${String(i).padStart(3, "0")}`;
    insert.run(
      id,
      "report",
      JSON.stringify({
        id,
        contextId: "archive-source",
        createdAt: 1780000000000 + i,
        title: `档案研究 ${String(i).padStart(3, "0")}`,
        summary: "合成报告摘要",
        supporting: ["合成支持证据"],
        opposing: ["合成反向证据"],
        risks: ["合成风险"],
        missing: ["数据时点未核验"],
        nextSteps: ["继续观察"],
        model: "fixture-model",
        promptVersion: "fixture-v1",
        tokens: 1,
        evidence: [
          {
            id: "ev-1",
            source: "fixture-source",
            asOf: "2026-05-28",
            text: i === 124 ? "合成证据".repeat(250000) : "合成证据正文",
          },
        ],
      }),
      1780000000000 + i,
    );
  }
  db.close();
  const requests = [];
  const errors = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/trpc/")) requests.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const start = performance.now();
  await page
    .getByRole("button", {
      name: phase === "before" ? "刷新列表" : "刷新当前页",
      exact: true,
    })
    .click();
  await page
    .getByRole(phase === "before" ? "button" : "link", {
      name: "档案研究 124",
      exact: true,
    })
    .waitFor();
  const refreshMs = performance.now() - start;
  await page.screenshot({
    path: join(dir, `${phase}-list.png`),
    fullPage: true,
  });
  await page
    .getByRole(phase === "before" ? "button" : "link", {
      name: "档案研究 124",
      exact: true,
    })
    .click();
  await page.getByText("合成报告摘要", { exact: true }).waitFor();
  await page.screenshot({
    path: join(dir, `${phase}-detail.png`),
    fullPage: true,
  });
  writeFileSync(
    join(dir, `browser-${phase}.json`),
    JSON.stringify({ phase, refreshMs, requests, errors }, null, 2),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ phase, refreshMs, requests: requests.length, errors }),
  );
} finally {
  await browser.close();
}

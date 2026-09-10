// R1 paired visual regression: identical DOM/data, original committed CSS vs R1.
// Start the server with QUANT_DATA_DIR=.test-data/r1/browser, port 3214.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const requireNext = createRequire(
  createRequire(import.meta.url).resolve("next/package.json"),
);
const sharp = requireNext("sharp");
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/r1/browser"),
);
const original = execFileSync(
  "git",
  ["show", "3375a15:src/styles/globals.css"],
  { encoding: "utf8" },
);
const oldCss = (
  await postcss([tailwind({ optimize: true })]).process(original, {
    from: resolve("src/styles/globals.css"),
  })
).css;
const destination = resolve("docs/review/r1-review");
for (const phase of ["before", "after"])
  await mkdir(join(destination, phase), { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1840, height: 1350 },
    timezoneId: "Asia/Shanghai",
  });
  await page.goto("http://127.0.0.1:3214");
  await page.getByRole("button", { name: "行情图表", exact: true }).waitFor();
  for (const [file, label, path] of [
    ["market", "行情图表"],
    ["screen", "条件选股"],
    ["signals", "信号与通知"],
    ["connections", "数据与连接"],
    ["signal-ledger", null, "/signal-ledger"],
    ["trade-ledger", null, "/trade-ledger"],
  ]) {
    if (path) await page.goto(`http://127.0.0.1:3214${path}`);
    else await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    // Pause polling and canvas animation only after data has settled.
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.addStyleTag({
      content: "nextjs-portal { visibility: hidden; }",
    });
    const capture = async (phase) => {
      await page.screenshot({
        path: join(destination, phase, `${file}.png`),
        fullPage: true,
        animations: "disabled",
      });
      const styles = await page.locator("body").evaluate((body) =>
        [...body.querySelectorAll("*:not(nextjs-portal)")]
          .filter(
            (el) => el.checkVisibility() && el.getBoundingClientRect().width,
          )
          .map((el) => {
            const s = getComputedStyle(el),
              b = el.getBoundingClientRect();
            return [
              el.tagName,
              el.className?.baseVal ?? el.className,
              b.x,
              b.y,
              b.width,
              b.height,
              s.color,
              s.backgroundColor,
              s.borderColor,
              s.font,
              s.padding,
              s.borderRadius,
            ];
          }),
      );
      await writeFile(
        join(destination, phase, `${file}.json`),
        JSON.stringify(styles, null, 2),
      );
      // Next's CSS compiler can serialize the same color as lab while the
      // standalone baseline emits oklch. Compare their browser-rendered RGBA,
      // retaining the unnormalized CSSOM values in the evidence JSON above.
      return page.evaluate((values) => {
        const context = document.createElement("canvas").getContext("2d");
        return values.map((entry) =>
          entry.map((value, index) => {
            if (![6, 7, 8].includes(index) || !CSS.supports("color", value))
              return value;
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data);
          }),
        );
      }, styles);
    };
    await page.evaluate((css) => {
      const baseline = document.createElement("style");
      baseline.id = "r1-original-css";
      baseline.textContent = css;
      document.head.append(baseline);
      for (const sheet of document.styleSheets)
        if (sheet.href) sheet.disabled = true;
    }, oldCss);
    await page.screenshot({ fullPage: true, animations: "disabled" });
    const before = await capture("before");
    await page.evaluate(() => {
      document.getElementById("r1-original-css").remove();
      for (const sheet of document.styleSheets)
        if (sheet.href) sheet.disabled = false;
    });
    const after = await capture("after");
    const a = await sharp(join(destination, "before", `${file}.png`))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const b = await sharp(join(destination, "after", `${file}.png`))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let changedPixels = 0;
    if (a.info.width === b.info.width && a.info.height === b.info.height) {
      for (let i = 0; i < a.data.length; i += a.info.channels)
        if (
          !a.data
            .subarray(i, i + a.info.channels)
            .equals(b.data.subarray(i, i + b.info.channels))
        )
          changedPixels++;
    } else changedPixels = -1;
    results.push({
      page: file,
      computedStylesAndGeometryEqual:
        JSON.stringify(before) === JSON.stringify(after),
      changedPixels,
      before: a.info,
      after: b.info,
    });
    await page.clock.resume();
  }
  console.log(results);
  await writeFile(
    join(destination, "comparison.json"),
    JSON.stringify(results, null, 2),
  );
  assert.ok(
    results.every(
      (r) => r.computedStylesAndGeometryEqual && r.changedPixels === 0,
    ),
    "Inspect each visual difference",
  );
} finally {
  await browser.close();
}

// Persistent R2b browser review; never connects to the production data directory.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const sharp = createRequire(
  createRequire(import.meta.url).resolve("next/package.json"),
)("sharp");
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/r2b/browser"),
);
const root = resolve("docs/review/r2b-review");
await mkdir(root, { recursive: true });
const oldCss = execFileSync(
  "git",
  ["show", "8ee88dabdea64166127ce41cf8dca2fb425baaea:src/styles/globals.css"],
  {
    encoding: "utf8",
  },
).match(/\.button \{[\s\S]*?(?=\.full \{)/)[0];
const bundle = await build({
  entryPoints: ["tests/r2b-browser-fixture.tsx"],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const result = {
  pages: [],
  interactions: [],
  externalRequests: [],
  errors: [],
};
async function pixels(first, second) {
  const a = await sharp(first)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const b = await sharp(second)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Math.min(a.info.width, b.info.width),
    height = Math.min(a.info.height, b.info.height);
  let changed = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * a.info.width + x) * 4,
        j = (y * b.info.width + x) * 4;
      if (!a.data.subarray(i, i + 4).equals(b.data.subarray(j, j + 4)))
        changed++;
    }
  return {
    changed,
    overlapPixels: width * height,
    before: [a.info.width, a.info.height],
    after: [b.info.width, b.info.height],
  };
}
try {
  const page = await browser.newPage({
    viewport: { width: 1840, height: 1350 },
    timezoneId: "Asia/Shanghai",
  });
  page.on("pageerror", (e) => result.errors.push(e.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      result.externalRequests.push(url.hostname);
      return route.abort();
    }
    if (/testChannel|retryDelivery|mock.*(order|account)/i.test(url.pathname))
      throw new Error("External action forbidden");
    return route.continue();
  });
  await page.goto("http://127.0.0.1:3216/ui-gallery");
  await page.waitForLoadState("networkidle");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const action = page.getByRole("button", {
    name: "fixture action",
    exact: true,
  });
  await action.click();
  assert.equal(await page.getByLabel("click count").textContent(), "1");
  await action.press("Space");
  assert.equal(await page.getByLabel("click count").textContent(), "2");
  assert.ok(await action.evaluate((el) => el.matches(":focus-visible")));
  assert.equal(
    await action.evaluate((el) => getComputedStyle(el).outlineWidth),
    "2px",
  );
  const disabled = page.getByRole("button", {
    name: "fixture disabled",
    exact: true,
  });
  assert.ok(await disabled.isDisabled());
  await disabled.evaluate((el) => el.click());
  assert.equal(await page.getByLabel("click count").textContent(), "2");
  assert.equal(
    await disabled.evaluate((el) => getComputedStyle(el).opacity),
    "0.5",
  );
  await action.focus();
  await page.keyboard.press("Tab");
  const link = page.getByRole("link", { name: "fixture link", exact: true });
  assert.ok(await link.evaluate((el) => el === document.activeElement));
  assert.equal(await link.locator("button").count(), 0);
  await link.press("Enter");
  assert.equal(await page.getByLabel("click count").textContent(), "3");
  assert.ok(page.url().endsWith("#r2b-target"));
  await page
    .getByRole("button", { name: "fixture plain", exact: true })
    .click();
  await page
    .getByRole("button", { name: "fixture submit", exact: true })
    .click();
  assert.equal(await page.getByLabel("click count").textContent(), "5");
  const classTokens = await page
    .locator("#r2b-fixture .button")
    .evaluateAll((els) => [...new Set(els.flatMap((el) => [...el.classList]))]);
  result.interactions.push(
    "click and Space invoke handler once",
    "disabled blocks click and is skipped by Tab",
    "keyboard focus-visible outline 2px",
    "Button asChild renders one anchor, merges handler, Enter navigates",
    "plain click and implicit submit preserved",
  );
  await page.screenshot({
    path: join(root, "interactions.png"),
    fullPage: true,
  });
  for (const [name, label] of [
    ["connections", "数据与连接"],
    ["signals", "信号与通知"],
    ["trade-ledger", null],
    ["signal-ledger", null],
    ["screen", "条件选股"],
    ["market", "行情图表"],
  ]) {
    await page.goto(`http://127.0.0.1:3216${label ? "" : `/${name}`}`);
    if (label)
      await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({
      content: "nextjs-portal { visibility: hidden; }",
    });
    await page.mouse.move(0, 0);
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    async function capture(phase) {
      await page.screenshot({
        path: join(dir, `${phase}.png`),
        fullPage: true,
        animations: "disabled",
      });
      return page.locator("button,a.button").evaluateAll((els) =>
        els
          .filter((el) => el.checkVisibility())
          .map((el) => {
            const r = el.getBoundingClientRect(),
              s = getComputedStyle(el);
            return {
              label: el.getAttribute("aria-label") ?? el.textContent.trim(),
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              font: s.font,
              padding: s.padding,
              radius: s.borderRadius,
              color: s.color,
              background: s.backgroundColor,
              border: s.border,
              shadow: s.boxShadow,
            };
          }),
      );
    }
    // Full-page chart capture settles fractional layout on the first pass.
    await page.screenshot({ fullPage: true, animations: "disabled" });
    const after = await capture("after");
    await page.evaluate(
      ({ classTokens, oldCss }) => {
        window.r2bClasses = [...document.querySelectorAll(".button")].map(
          (el) => [el, el.className],
        );
        for (const [el, cls] of window.r2bClasses) {
          const variant = cls.includes("bg-primary")
            ? "primary"
            : cls.includes("bg-card")
              ? "outline"
              : cls.includes("bg-transparent")
                ? "ghost"
                : "danger";
          const sm = cls.includes("text-[11px]");
          el.className =
            [...el.classList]
              .filter((c) => !classTokens.includes(c))
              .join(" ") + ` button button-${variant}${sm ? " button-sm" : ""}`;
        }
        const style = document.createElement("style");
        style.id = "r2b-old-button-css";
        style.textContent = oldCss;
        document.head.append(style);
      },
      { classTokens, oldCss },
    );
    const before = await capture("same-data-r2");
    await page.evaluate(() => {
      document.getElementById("r2b-old-button-css").remove();
      for (const [el, cls] of window.r2bClasses) el.className = cls;
    });
    const differences = after.flatMap((control, i) => {
      const fields = Object.keys(control).filter(
        (key) => control[key] !== before[i]?.[key],
      );
      return fields.length
        ? [{ label: control.label, fields, before: before[i], after: control }]
        : [];
    });
    const historical = JSON.parse(
      await readFile(`docs/review/r2-review/${name}/after.json`, "utf8"),
    );
    const entry = {
      name,
      differences,
      pairedPixels: await pixels(
        join(dir, "same-data-r2.png"),
        join(dir, "after.png"),
      ),
      historicalPixels: await pixels(
        `docs/review/r2-review/${name}/after.png`,
        join(dir, "after.png"),
      ),
      historicalControls: historical.controls.filter((c) => c.tag === "BUTTON"),
      before,
      after,
    };
    result.pages.push(entry);
    console.log(
      name,
      JSON.stringify({
        paired: entry.pairedPixels,
        geometry: differences.filter((d) =>
          d.fields.some((k) =>
            ["x", "y", "width", "height", "font", "padding", "radius"].includes(
              k,
            ),
          ),
        ).length,
      }),
    );
    if (name === "market") {
      await page.setViewportSize({ width: 650, height: 900 });
      const heading = page.locator(".page-heading > .button");
      assert.equal(
        await heading.evaluate((el) => getComputedStyle(el).fontSize),
        "0px",
      );
      assert.equal(
        await heading.evaluate((el) => getComputedStyle(el).padding),
        "10px",
      );
      assert.equal(
        await heading
          .locator("svg")
          .evaluate((el) => getComputedStyle(el).width),
        "15px",
      );
      await page.screenshot({ path: join(dir, "mobile.png"), fullPage: true });
      result.interactions.push(
        "650px heading retains 0px label, 10px padding, 15px icon",
      );
    }
  }
  assert.deepEqual(result.errors, []);
} finally {
  await writeFile(
    join(root, "comparison.json"),
    JSON.stringify(result, null, 2),
  );
  await browser.close();
}

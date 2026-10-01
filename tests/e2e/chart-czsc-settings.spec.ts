import { expect, test } from "@playwright/test";
import { waitForIdleServer } from "./helpers";

const stored = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("nq-czsc-settings") ?? "{}") as {
        state?: { values?: Record<string, number> };
      },
  );

test("缠论设置 is generated from the DLL schema and drives one v20 build", async ({
  page,
}) => {
  await waitForIdleServer(page);
  // A pre-v20 persisted shape must migrate to schema keys on load.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(
        "nq-czsc-settings",
        JSON.stringify({
          state: { stroke: 0, segment: 1, centerMode: 0, box: "initial" },
          version: 0,
        }),
      );
    }
  });
  await page.goto("/market", { waitUntil: "networkidle" });
  const chart = page.getByTestId("market-chart").first();
  await chart.locator("canvas").first().waitFor();
  const status = page.getByTestId("czsc-status").first();
  await expect(status).toContainText(/笔 \d+/, { timeout: 120_000 });
  expect((await stored(page)).state?.values).toMatchObject({
    "stroke.rule": 0,
    "segment.method": 1,
    "center.strokeFormation": 0,
    "projection.centerBox": 0,
  });
  const before = await status.innerText();

  await page.getByRole("button", { name: "缠论设置" }).click();
  // Opening must not pop a tooltip by auto-focusing the first info icon.
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  // Each row explains its choices with the DLL's own notes.
  await page.getByRole("button", { name: "笔算法说明" }).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("独立K线");
  await expect(tip).toContainText("分型笔");
  await expect(tip).toContainText("上证指数样本端点数");
  await page.screenshot({ path: "test-results/czsc-settings-tooltip.png" });
  // Radix closes on pointermove outside its grace area; hover() jumps without moves.
  const away = (await page
    .getByRole("combobox", { name: "线段算法" })
    .boundingBox())!;
  await page.mouse.move(away.x + 50, away.y + 10, { steps: 20 });
  await expect(tip).toBeHidden();
  await expect(page.getByRole("dialog")).toContainText("独立K线");
  await page.getByRole("combobox", { name: "笔算法" }).click();
  await expect(page.getByRole("option", { name: /严格笔/ })).toBeVisible();
  await page.getByRole("option", { name: /分型笔（社区口径）/ }).click();
  // Fractal strokes have no span threshold: the DLL rule disables gaps and says why.
  await expect(page.getByRole("combobox", { name: "笔中缺口" })).toBeDisabled();
  await expect(page.getByRole("dialog")).toContainText("分型笔");
  await page.keyboard.press("Escape");

  await expect(status).not.toHaveText(before, { timeout: 120_000 });
  await expect(status).toContainText(/笔 \d+/);
  expect((await stored(page)).state?.values?.["stroke.rule"]).toBe(4);

  // Gaps (v7) apply to span-based strokes.
  await page.getByRole("button", { name: "缠论设置" }).click();
  await page.getByRole("combobox", { name: "笔算法" }).click();
  await page.getByRole("option", { name: /严格笔/ }).click();
  const gap = page.getByRole("combobox", { name: "笔中缺口" });
  await expect(gap).toBeEnabled();
  await gap.click();
  await page.getByRole("option", { name: /大缺口成笔/ }).click();
  await expect(
    page.getByRole("spinbutton", { name: "大缺口阈值" }),
  ).toHaveValue("0.02");

  // The segment boundary only applies to feature-sequence segments.
  const boundary = page.getByRole("combobox", { name: "线段分界点" });
  await expect(boundary).toBeEnabled();
  await page.getByRole("combobox", { name: "线段算法" }).click();
  await page.getByRole("option", { name: /启发式/ }).click();
  await expect(boundary).toBeDisabled();
  await page.getByRole("combobox", { name: "线段算法" }).click();
  await page.getByRole("option", { name: /特征序列/ }).click();
  await boundary.click();
  await page.getByRole("option", { name: /合并首笔/ }).click();
  await page.keyboard.press("Escape");
  expect((await stored(page)).state?.values).toMatchObject({
    "stroke.gap": 2,
    "projection.segmentBoundary": 1,
  });

  // Stroke-center formation changes the stroke level's centers.
  const centersBefore = await status.innerText();
  await page.getByRole("button", { name: "缠论设置" }).click();
  await page.getByRole("combobox", { name: "笔中枢构成" }).click();
  await page.getByRole("option", { name: /服从所属线段/ }).click();
  await page.keyboard.press("Escape");
  await expect(status).not.toHaveText(centersBefore, { timeout: 120_000 });

  // Persisted across reloads; restore the default for other specs.
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "缠论设置" }).click();
  await expect(
    page.getByRole("combobox", { name: "笔中枢构成" }),
  ).toContainText("服从所属线段");
  await page.getByRole("button", { name: "恢复默认" }).click();
  expect((await stored(page)).state?.values).toEqual({
    "projection.centerBox": 0,
  });
});

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { trpcHeaders } from "./helpers";

const strategy = "QA-r3b-decay";

for (const width of [1440, 1024]) {
  test(`Lifecycle review ${width}: bulk link, journal, decay suggestion and confirmed pause`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const read = async (name: string, input?: unknown) => {
      const suffix =
        input === undefined
          ? ""
          : "?input=" + encodeURIComponent(JSON.stringify({ json: input }));
      const response = await page.request.get(`/api/trpc/${name}${suffix}`, {
        headers: trpcHeaders,
      });
      expect(response.ok()).toBe(true);
      return (await response.json()).result.data.json;
    };
    const status = (await read("databaseStatus")) as { database: string };
    const owner = resolve(process.env.E2E_DATA_DIR!);
    const screens = resolve(owner, "..", "screens");
    await mkdir(screens, { recursive: true });
    const child = relative(owner, resolve(status.database));
    expect(isAbsolute(status.database)).toBe(true);
    expect(child && !child.startsWith("..") && !isAbsolute(child)).toBeTruthy();
    // Reset only synthetic linkage/live metadata between viewport runs.
    // Original imported fills/cash rows and their prior audit entries remain.
    const setup = new Database(status.database);
    try {
      const marker = setup
        .prepare("SELECT payload FROM records WHERE id=?")
        .get("qa-lifecycle-review-fixture") as { payload: string };
      expect(JSON.parse(marker.payload)).toEqual({ synthetic: true });
      setup
        .transaction(() => {
          const fills = setup
            .prepare("SELECT id FROM trade_fills WHERE account=?")
            .all("QA-l5-review") as { id: string }[];
          for (const fill of fills)
            setup
              .prepare("DELETE FROM account_trade_links WHERE trade_id=?")
              .run(`delivery:${fill.id}`);
          setup
            .prepare("UPDATE records SET payload=? WHERE id=?")
            .run(
              JSON.stringify({ live: true, unvalidatedOverride: true }),
              `alerts:strategy:${strategy}:1`,
            );
        })
        .immediate();
    } finally {
      setup.close();
    }
    const originalTradeHash = () => {
      const db = new Database(status.database, { readonly: true });
      try {
        return createHash("sha256")
          .update(
            JSON.stringify({
              ledger: db
                .prepare("SELECT * FROM trade_ledger ORDER BY id")
                .all(),
              fills: db.prepare("SELECT * FROM trade_fills ORDER BY id").all(),
              cash: db.prepare("SELECT * FROM cash_flows ORDER BY id").all(),
              batches: db
                .prepare("SELECT * FROM import_batches ORDER BY id")
                .all(),
              paper: db
                .prepare("SELECT * FROM paper_accounts ORDER BY id")
                .all(),
              paperState: db
                .prepare("SELECT * FROM paper_state ORDER BY account_id")
                .all(),
              paperFacts: db
                .prepare(
                  "SELECT * FROM paper_facts ORDER BY account_id,kind,id",
                )
                .all(),
            }),
          )
          .digest("hex");
      } finally {
        db.close();
      }
    };
    const before = originalTradeHash();
    const outbound: string[] = [];
    page.on("request", (request) => {
      if (!/^(127\.0\.0\.1|localhost)$/.test(new URL(request.url()).hostname))
        outbound.push(request.url());
    });
    // Each width starts from the same explicit synthetic metadata state.
    // The browser action below, not setup, must perform the pause itself.
    const labBefore = await read("strategyLabDetail", {
      id: strategy,
      version: 1,
    });
    const initiallyLive = labBefore.live as boolean;
    expect(labBefore.eligible).toBe(false);
    expect(initiallyLive).toBe(true);

    await page.goto("/accounts?tab=trades");
    const bulk = page.getByRole("region", { name: "批量关联计划" });
    await expect(bulk).toContainText("当前选择 2 笔");
    await bulk.getByRole("button", { name: "确认关联所选 2 笔" }).click();
    await expect(bulk.getByRole("status")).toHaveText(
      "已关联 2 笔，原成交未改写。",
    );
    const trades = (await read("accountTrades", { page: 0 })).trades as {
      id: string;
      account: string;
      side: string;
    }[];
    const tradeId = trades.find(
      (trade) => trade.account === "QA-l5-review" && trade.side === "sell",
    )!.id;
    const linked = await read("accountJournalContext", tradeId);
    expect(linked.trade.planId).toBe("QA-l5-bulk-plan");
    const row = page.getByRole("row").filter({ hasText: "2026-01-07" });
    await row.getByRole("button", { name: "交易日志", exact: true }).click();
    await row.getByRole("combobox", { name: "退出原因" }).click();
    await page.getByRole("option", { name: "止损", exact: true }).click();
    await row
      .getByLabel("复盘记录", { exact: true })
      .fill(`QA-${width}-journal`);
    await row.getByLabel("交易日志标签", { exact: true }).fill("QA,lifecycle");
    await row.getByRole("button", { name: "保存日志", exact: true }).click();
    await expect(row.getByRole("status")).toHaveText(
      "已保存元数据，原成交保留。",
    );
    const journal = await read("accountJournalContext", tradeId);
    expect(journal.journal.note).toBe(`QA-${width}-journal`);
    expect(journal.journal.tags).toEqual(["QA", "lifecycle"]);
    expect(journal.journal.exitReason).toBe("stop");
    expect(originalTradeHash()).toBe(before);
    await page.screenshot({
      path: resolve(screens, `review-journal-${width}.png`),
      fullPage: true,
    });

    await page.goto("/lab?tab=catalog");
    await page
      .getByRole("radiogroup", { name: "策略中心工作区" })
      .getByRole("radio", { name: "研究成绩单", exact: true })
      .click();
    const scoreboard = page.getByRole("region", { name: "策略研究成绩单" });
    await expect(scoreboard).toContainText("QA lifecycle review");
    await expect(scoreboard).toContainText("前推一致性：证据不足");
    await expect(scoreboard).not.toContainText("OLD SHADOW CAN ENABLE LIVE");
    await expect(scoreboard.getByText("已晋级", { exact: true })).toHaveCount(
      0,
    );

    await page.goto("/accounts?tab=paper");
    const paper = page.getByRole("region", {
      name: "纸面模拟账户",
      exact: true,
    });
    await expect(paper).toContainText("QA-r2c");
    await expect(paper).not.toContainText("OLD PAPER CAN ENABLE LIVE");
    await paper.getByRole("button", { name: /模拟 · QA-r2c/ }).click();
    await expect(paper).toContainText("证据不足");
    await expect(paper).not.toContainText("OLD PAPER CAN ENABLE LIVE");
    expect(
      JSON.stringify(await read("paperAccount", "paper:QA-r2c")),
    ).not.toContain("OLD PAPER CAN ENABLE LIVE");
    expect(originalTradeHash()).toBe(before);

    await page.goto(`/lab?strategy=${strategy}&version=1`);
    const detail = page.getByRole("region", { name: "实验室策略详情" });
    await expect(detail.getByText("已晋级", { exact: true })).toHaveCount(0);
    if (initiallyLive) {
      const suggestion = detail.getByRole("region", { name: "策略暂停建议" });
      await expect(suggestion).toContainText("同参数衰减");
      await page.screenshot({
        path: resolve(screens, `review-lab-${width}.png`),
        fullPage: true,
      });
      const pauseRequests: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().includes("strategyLabAction")
        )
          pauseRequests.push(request.url());
      });
      await suggestion
        .getByRole("button", { name: "按复盘建议暂停正式提醒", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toContainText("确认暂停正式提醒");
      await page.keyboard.press("Escape");
      expect(pauseRequests).toEqual([]);
      expect(
        (await read("strategyLabDetail", { id: strategy, version: 1 })).live,
      ).toBe(true);

      await page.goto("/accounts?tab=weekly");
      const weekly = page.getByRole("region", { name: "周度复盘" });
      await weekly.getByLabel("周复盘起始日期").fill("2026-01-05");
      await expect(weekly).toContainText("QA-l5-review");
      await expect(weekly).toContainText("退出原因 stop");
      page.once("dialog", async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toContain(strategy);
        await dialog.accept();
      });
      await weekly
        .getByRole("button", { name: "暂停正式提醒", exact: true })
        .click();
      await expect(weekly.getByRole("status")).toHaveText(
        "已按确认暂停正式提醒。",
      );
      const after = await read("strategyLabDetail", {
        id: strategy,
        version: 1,
      });
      expect(after.live).toBe(false);
      expect(after.shadow).toEqual(labBefore.shadow);
      expect(after.promotion).toEqual(labBefore.promotion);
      expect(pauseRequests).toHaveLength(1);
      await page.screenshot({
        path: resolve(screens, `review-weekly-${width}.png`),
        fullPage: true,
      });
    }
    expect(originalTradeHash()).toBe(before);
    expect(outbound).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

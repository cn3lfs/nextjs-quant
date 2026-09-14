import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createTdxClient, fromBestHost, pingAll } from "../src/index";

it.skipIf(process.env.TSTDX_LIVE !== "1")(
  "exercises the complete public query surface on real servers",
  async () => {
    const rows: Record<string, unknown>[] = [];
    for (const host of (process.env.TSTDX_LIVE_HOSTS ?? "180.153.18.170").split(
      ",",
    )) {
      const c = createTdxClient({
        hosts: [host],
        timeoutMs: 3000,
        requestRetries: 0,
      });
      const cases: [string, () => Promise<unknown>][] = [
        ["securityCount/sh", () => c.securityCount("sh")],
        ["securityCount/sz", () => c.securityCount("sz")],
        ["securityCount/bj", () => c.securityCount("bj")],
        ["securityList/sh", () => c.securityList("sh")],
        ["securityList/sz", () => c.securityList("sz")],
        ["securityList/bj", () => c.securityList("bj")],
        ["stocks/sh", () => c.stocks("sh")],
        ["stocks/sz", () => c.stocks("sz")],
        ["stocks/bj", () => c.stocks("bj")],
        ["allStocks", () => c.allStocks({ withIndustry: true })],
        ["companyInfoCategories", () => c.companyInfoCategories("sh600000")],
        [
          "companyInfoContent",
          async () => {
            const first = (await c.companyInfoCategories("sh600000"))[0];
            if (!first) throw Error("empty category");
            return c.companyInfoContent(
              "sh600000",
              first.filename,
              first.start,
              first.length,
            );
          },
        ],
        ["f10", () => c.f10("sh600000")],
        ["blockMeta", () => c.blockMeta("block_gn.dat")],
        ["fileChunk", () => c.fileChunk("tdxhy.cfg", 0)],
        ["reportFile/tdxhy.cfg", () => c.reportFile("tdxhy.cfg")],
        ["reportFile/gpcw.txt", () => c.reportFile("gpcw.txt")],
        ["reportFile/base_info.zip", () => c.reportFile("base_info.zip")],
        ["blockInfo/gn", () => c.blockInfo("block_gn.dat")],
        ["blockInfo/zs", () => c.blockInfo("block_zs.dat")],
        ["blockInfo/fg", () => c.blockInfo("block_fg.dat")],
        ["blockMembers", () => c.blockMembers()],
        ["industryMap", () => c.industryMap()],
        ["bars", () => c.bars("sh600000", "day", 0, 3)],
        ["bars/index", () => c.bars("sh000001", "day", 0, 3)],
        ["barsRange", () => c.barsRange("sh600000", "day", 20260910, 20260914)],
        [
          "indexBarsRange",
          () => c.indexBarsRange("sh000001", "day", 20260910, 20260914),
        ],
        ["k", () => c.k("sh600000", 20260910, 20260914)],
        [
          "barsBatch",
          () =>
            c.barsBatch(["sh600000", "sz300750"], "day", 20260910, 20260914),
        ],
        [
          "kBatch",
          () => c.kBatch(["sh600000", "sz300750"], 20260910, 20260914),
        ],
        [
          "kAdjusted/qfq",
          () => c.kAdjusted("sh600000", "qfq", 20260910, 20260914),
        ],
        [
          "kAdjusted/hfq",
          () => c.kAdjusted("sh600000", "hfq", 20260910, 20260914),
        ],
        ["marketStat", () => c.marketStat()],
        ["priceLimits", () => c.priceLimits("sh600000", 9.26)],
        [
          "priceLimits/explicit-age",
          () => c.priceLimits("sh600000", 9.26, { listedDays: 10 }),
        ],
        ["transactionsAll", () => c.transactionsAll("sh600000")],
        [
          "transactionsAll/history",
          () => c.transactionsAll("sh600000", 20260914),
        ],
        ["fundFlow", () => c.fundFlow("sh600000")],
        ["historyFundFlowPage", () => c.historyFundFlowPage("sh600000")],
        ["historyFundFlow", () => c.historyFundFlow("sh600000")],
        ["securityQuotes", () => c.securityQuotes(["sh600000"])],
        ["barPage", () => c.barPage("sh600000", "day", 0, 3)],
        ["indexBarPage", () => c.indexBarPage("sh000001", "day", 0, 3)],
        ["minutes", () => c.minutes("sz300750")],
        ["historyMinutes", () => c.historyMinutes("sz300750", 20260914)],
        ["transactionPage", () => c.transactionPage("sh600000", 0, 3)],
        [
          "historyTransactionPage",
          () => c.historyTransactionPage("sh600000", 20260914, 0, 3),
        ],
        ["xdxr", () => c.xdxr("sh600000")],
        ["finance", () => c.finance("sh600000")],
        ["heartbeat", () => c.heartbeat()],
        ["reconnect", () => c.reconnect()],
        ["retry", () => c.retry(() => c.securityCount("sh"), 2)],
        [
          "startHeartbeat/stopHeartbeat",
          async () => {
            const stop = c.startHeartbeat(100);
            await new Promise((r) => setTimeout(r, 250));
            stop();
            return c.heartbeat();
          },
        ],
        ["pingAll", () => pingAll([host])],
        [
          "fromBestHost",
          async () => {
            const best = await fromBestHost({ hosts: [host] });
            try {
              return await best.securityCount("sh");
            } finally {
              await best.close();
            }
          },
        ],
      ];
      try {
        for (const [name, run] of cases) {
          await c.close();
          const startedAt = Date.now();
          const row: Record<string, unknown> = { host, name, startedAt };
          try {
            const data = await run();
            const count =
              Array.isArray(data) ||
              typeof data === "string" ||
              Buffer.isBuffer(data)
                ? data.length
                : data instanceof Map
                  ? data.size
                  : 1;
            row.status = count ? "data" : "empty";
            row.count = count;
            if (Buffer.isBuffer(data))
              row.sha256 = createHash("sha256").update(data).digest("hex");
            else if (typeof data === "string") {
              row.characters = data.length;
              row.sha256 = createHash("sha256").update(data).digest("hex");
            } else if (data instanceof Map)
              row.first = [...data.entries()].slice(0, 1);
            else if (Array.isArray(data)) {
              row.first = data.slice(0, 1);
              row.last = data.slice(-1);
              if (name.endsWith("Batch")) {
                row.items = data;
                row.status = data.every((x) => x.status === "data")
                  ? "data"
                  : "partial-or-failed";
              }
            } else row.value = data;
          } catch (error) {
            row.status = "error";
            row.error = String(error);
          }
          row.elapsedMs = Date.now() - startedAt;
          rows.push(row);
          if (process.env.TSTDX_LIVE_REPORT)
            await writeFile(
              process.env.TSTDX_LIVE_REPORT,
              JSON.stringify(rows, null, 2),
            );
        }
      } finally {
        await c.close();
      }
    }
    if (process.env.TSTDX_LIVE_REPORT)
      await writeFile(
        process.env.TSTDX_LIVE_REPORT,
        JSON.stringify(rows, null, 2),
      );
    expect(
      rows
        .filter((r) => r.status !== "data")
        .map(({ host, name, status, error }) => ({
          host,
          name,
          status,
          error,
        })),
    ).toEqual([]);
  },
  240000,
);

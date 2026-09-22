import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import * as api from "../src/server/data-sources/tdx/tdx-quotes";
import { KLINE, type KlineName } from "../src/server/data-sources/tdx/tdx-wire";

it.skipIf(process.env.QUANT_TSTDX_ALL !== "1")(
  "audits every public data query and all implemented periods without fallback",
  async () => {
    const original = process.env.TDX_HOSTS;
    const rows: Record<string, unknown>[] = [];
    try {
      for (const host of [
        "180.153.18.170",
        "124.71.187.122",
        "115.238.56.198",
      ]) {
        process.env.TDX_HOSTS = host;
        const cases: { name: string; run: () => Promise<unknown> }[] = [
          {
            name: "securityQuotes",
            run: () => api.securityQuotes(["sh600000", "sz300750"]),
          },
          { name: "barPage", run: () => api.barPage("sh600000", "day", 0, 3) },
          {
            name: "indexBarPage",
            run: () => api.indexBarPage("sh000001", "day", 0, 3),
          },
          { name: "minutes", run: () => api.minutes("sh600000") },
          {
            name: "historyMinutes",
            run: () => api.historyMinutes("sh600000", 20260914),
          },
          {
            name: "transactionPage",
            run: () => api.transactionPage("sh600000", 0, 3),
          },
          {
            name: "historyTransactionPage",
            run: () => api.historyTransactionPage("sh600000", 20260914, 0, 3),
          },
          { name: "xdxr", run: () => api.xdxr("sh600000") },
          { name: "finance", run: () => api.finance("sh600000") },
        ];
        if (host === "180.153.18.170") {
          for (const period of Object.keys(KLINE) as KlineName[]) {
            cases.push({
              name: `barPage/${period}`,
              run: () => api.barPage("sh600000", period, 0, 3),
            });
            cases.push({
              name: `indexBarPage/${period}`,
              run: () => api.indexBarPage("sh000001", period, 0, 3),
            });
          }
        }
        for (const item of cases) {
          await api.closeQuotes();
          const row: Record<string, unknown> = {
            host,
            name: item.name,
            startedAt: Date.now(),
          };
          try {
            const data = await item.run();
            row.status = Array.isArray(data) && !data.length ? "empty" : "data";
            row.count = Array.isArray(data) ? data.length : 1;
            row.data = data;
          } catch (error) {
            row.status = "error";
            row.error = String(error);
          }
          rows.push(row);
        }
      }
    } finally {
      await api.closeQuotes();
      if (original === undefined) delete process.env.TDX_HOSTS;
      else process.env.TDX_HOSTS = original;
      if (process.env.QUANT_TSTDX_REPORT)
        await writeFile(
          process.env.QUANT_TSTDX_REPORT,
          JSON.stringify(rows, null, 2),
        );
    }
    expect(rows).toHaveLength(27 + Object.keys(KLINE).length * 2);
    expect(
      rows
        .filter((row) => row.status !== "data")
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

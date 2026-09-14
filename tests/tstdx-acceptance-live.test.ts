import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { TDX_HOSTS, TdxSession } from "../src/server/tdx-quotes";
import {
  buildBarsRequest,
  parseBars,
  buildQuotesRequest,
  parseQuotes,
} from "../src/server/tdx-wire";

// Explicit opt-in: TCP/handshake success is not a successful market-data read.
it.skipIf(process.env.QUANT_TSTDX_ACCEPTANCE !== "1")(
  "audits servers and the seven portable securities without switching data providers",
  async () => {
    const hosts = await Promise.all(
      TDX_HOSTS.map(async (host) => {
        let session: TdxSession | undefined;
        const result: Record<string, unknown> = { host, startedAt: Date.now() };
        try {
          session = await TdxSession.connect(host, 7709, 3000);
          result.connected = true;
          const body = await session.request(
            buildBarsRequest("sh600000", "day", 0, 3),
          );
          result.bytes = body.length;
          result.prefix = body.subarray(0, 24).toString("hex");
          try {
            result.bars = parseBars(body, "day");
          } catch (error) {
            result.barError = String(error);
          }
          const quotes = await session.request(
            buildQuotesRequest(["sh600000"]),
          );
          result.quoteBytes = quotes.length;
          result.quotePrefix = quotes.subarray(0, 24).toString("hex");
          try {
            result.quotes = parseQuotes(quotes, ["sh600000"]);
          } catch (error) {
            result.quoteError = String(error);
          }
        } catch (error) {
          result.error = String(error);
        } finally {
          await session?.close();
        }
        result.completedAt = Date.now();
        return result;
      }),
    );
    const selected =
      hosts.find((host) => Array.isArray(host.bars) && host.bars.length) ??
      hosts.find((host) => host.connected);
    const cases: Record<string, unknown>[] = [];
    if (selected) {
      const session = await TdxSession.connect(
        String(selected.host),
        7709,
        3000,
      );
      try {
        for (const symbol of [
          "sh600000",
          "sz000001",
          "sz300750",
          "sh688981",
          "bj920002",
          "sh000001",
          "sh510300",
        ])
          for (const period of ["day", "week", "5m"] as const) {
            const item: Record<string, unknown> = {
              symbol,
              period,
              host: selected.host,
            };
            try {
              const body = await session.request(
                buildBarsRequest(symbol, period, 0, 3),
              );
              item.bytes = body.length;
              item.prefix = body.subarray(0, 24).toString("hex");
              const bars = parseBars(body, period, symbol === "sh000001");
              item.bars = bars;
              item.ok = bars.length === 3;
            } catch (error) {
              item.ok = false;
              item.error = String(error);
            }
            cases.push(item);
          }
      } finally {
        await session.close();
      }
    }
    const report = {
      checkedAt: new Date().toISOString(),
      hosts,
      cases,
      sector:
        "腾讯pt板块代码不可直接用于TDX；尚无核验过的同一板块代码映射，未测试",
    };
    if (process.env.QUANT_TSTDX_REPORT)
      await writeFile(
        process.env.QUANT_TSTDX_REPORT,
        JSON.stringify(report, null, 2),
      );
    expect(cases.length, "没有完成握手的服务器").toBe(21);
    expect(
      cases.filter((item) => item.ok).length,
      JSON.stringify(
        cases.map(({ symbol, period, error }) => ({ symbol, period, error })),
      ),
    ).toBe(21);
  },
  90000,
);

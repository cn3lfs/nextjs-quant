import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { TdxSession } from "../src/server/data-sources/tdx/tdx-quotes";
import * as wire from "../src/server/data-sources/tdx/tdx-wire";

it.skipIf(process.env.QUANT_TSTDX_INTERFACES !== "1")(
  "checks the remaining TCP interfaces independently without provider fallback",
  async () => {
    const results = await Promise.all(
      ["180.153.18.170", "124.71.187.122", "115.238.56.198"].map(
        async (host) => {
          const rows: Record<string, unknown>[] = [];
          for (const symbol of ["sh600000", "sz300750"]) {
            const cases: {
              name: string;
              request: Buffer;
              parse: (body: Buffer) => unknown;
            }[] = [
              {
                name: "minutes",
                request: wire.buildMinuteRequest(symbol),
                parse: (b) => wire.parseMinutes(b, symbol, false),
              },
              ...[20260914, 20260911, 20260910].map((date) => ({
                name: `historyMinutes/${date}`,
                request: wire.buildHistoryMinuteRequest(symbol, date),
                parse: (b: Buffer) => wire.parseMinutes(b, symbol, true),
              })),
              ...[0, 3].map((start) => ({
                name: `transactionPage/${start}`,
                request: wire.buildTransactionsRequest(symbol, start, 3),
                parse: (b: Buffer) => wire.parseTransactions(b, false),
              })),
              ...[20260914, 20260911].flatMap((date) =>
                [0, 3].map((start) => ({
                  name: `historyTransactionPage/${date}/${start}`,
                  request: wire.buildHistoryTransactionsRequest(
                    symbol,
                    date,
                    start,
                    3,
                  ),
                  parse: (b: Buffer) => wire.parseTransactions(b, true),
                })),
              ),
              {
                name: "xdxr",
                request: wire.buildXdxrRequest(symbol),
                parse: (b) => wire.parseXdxr(b, symbol),
              },
              {
                name: "finance",
                request: wire.buildFinanceRequest(symbol),
                parse: (b) => wire.parseFinance(b, symbol),
              },
            ];
            for (const item of cases) {
              let session: TdxSession | undefined;
              const row: Record<string, unknown> = {
                host,
                symbol,
                name: item.name,
                startedAt: Date.now(),
                requestHex: item.request.toString("hex"),
              };
              try {
                session = await TdxSession.connect(host, 7709, 3000);
                row.connected = true;
                const body = await session.request(item.request);
                row.bytes = body.length;
                row.prefix = body.subarray(0, 24).toString("hex");
                try {
                  const data = item.parse(body);
                  row.status =
                    Array.isArray(data) && !data.length ? "empty" : "data";
                  row.count = Array.isArray(data) ? data.length : 1;
                  row.data = data;
                } catch (error) {
                  row.status = "parse-error";
                  row.error = String(error);
                }
              } catch (error) {
                row.status = "transport-error";
                row.error = String(error);
              } finally {
                await session?.close();
                row.completedAt = Date.now();
              }
              rows.push(row);
            }
          }
          return rows;
        },
      ),
    );
    const rows = results.flat();
    if (process.env.QUANT_TSTDX_REPORT)
      await writeFile(
        process.env.QUANT_TSTDX_REPORT,
        JSON.stringify({ checkedAt: new Date().toISOString(), rows }, null, 2),
      );
    expect(rows).toHaveLength(72);
    expect(
      rows
        .filter((row) => row.status !== "data")
        .map(({ host, symbol, name, status, error }) => ({
          host,
          symbol,
          name,
          status,
          error,
        })),
    ).toEqual([]);
  },
  240000,
);

it.skipIf(process.env.QUANT_TSTDX_INTERFACES !== "1")(
  "validates historical minutes through the public pooled API",
  async () => {
    const api = await import("../src/server/data-sources/tdx/tdx-quotes");
    const previous = process.env.TDX_HOSTS;
    process.env.TDX_HOSTS = "180.153.18.170";
    try {
      for (const symbol of ["sh600000", "sz300750"]) {
        for (const date of [20260914, 20260911, 20260910]) {
          const points = await api.historyMinutes(symbol, date);
          expect(points).toHaveLength(240);
          expect(
            points.every(
              (point) =>
                Number.isFinite(point.price) &&
                point.price > 0 &&
                Number.isInteger(point.volume) &&
                point.volume >= 0,
            ),
          ).toBe(true);
        }
        expect(await api.minutes(symbol)).toHaveLength(240);
        expect(
          await api.historyTransactionPage(symbol, 20260914, 0, 3),
        ).toHaveLength(3);
        expect((await api.xdxr(symbol)).length).toBeGreaterThan(0);
        expect((await api.finance(symbol)).updatedDate).toBeGreaterThan(
          20260101,
        );
      }
    } finally {
      await api.closeQuotes();
      if (previous === undefined) delete process.env.TDX_HOSTS;
      else process.env.TDX_HOSTS = previous;
    }
  },
  60000,
);

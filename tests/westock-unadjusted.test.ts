import { expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { westockUnadjustedRequest } from "../src/server/data-sources/westock/westock-unadjusted";
import { query } from "../src/server/data-sources/westock/westock-data";
import { parseTencentChart } from "../src/server/market/free-chart-sources";
import { parseBars } from "../src/server/data-sources/tdx/tdx-wire";
const endpoint =
  "https://proxy.finance.qq.com/cgi/cgi-bin/openai/openclaw/proxy";
const init = {
  method: "POST",
  body: JSON.stringify({
    params: { codes: ["sz300750"], ktype: "day", fqtype: "bfq" },
  }),
};
it("changes only the documented unadjusted kline parameter on the exact Tencent endpoint", () => {
  const result = westockUnadjustedRequest(endpoint, init)!;
  expect(JSON.parse(result.body as string)).toEqual({
    params: { codes: ["sz300750"], ktype: "day", fqtype: "" },
  });
  expect(JSON.parse(init.body).params.fqtype).toBe("bfq");
  for (const url of [
    "https://example.com/cgi/cgi-bin/openai/openclaw/proxy",
    "https://proxy.finance.qq.com/other",
  ])
    expect(westockUnadjustedRequest(url, init)).toBe(init);
  for (const body of [
    "invalid JSON",
    "null",
    JSON.stringify({
      params: { codes: ["sz300750"], ktype: "day", fqtype: "qfq" },
    }),
    JSON.stringify({
      params: { codes: ["usAAPL"], ktype: "day", fqtype: "bfq" },
    }),
  ]) {
    const other = { ...init, body };
    expect(westockUnadjustedRequest(endpoint, other)).toBe(other);
  }
});
it("returns explicit CLI service errors instead of accepting exit code zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-westock-error-"));
  const script = join(dir, "error.cjs");
  await writeFile(
    script,
    'console.log(JSON.stringify({success:false,error:{code:"SKILL_006_2"}}))',
  );
  await expect(query(script, ["search", "300750"])).rejects.toThrow(
    "SKILL_006_2",
  );
});
it("runs the compatibility loader only in the child and keeps successful raw data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quant-westock-child-"));
  const script = join(dir, "index.cjs");
  await writeFile(
    script,
    'console.log(JSON.stringify([{date:"2026-09-14",open:334.51,last:337.11,high:341.81,low:334,volume:261849,amount:8871517269}]))',
  );
  const fetch = globalThis.fetch;
  const raw = await query(script, ["kline", "sz300750", "--fq", "bfq"]);
  expect(parseTencentChart(raw, "sz300750", "day")[0]?.close).toBe(337.11);
  expect(globalThis.fetch).toBe(fetch);
});
it("normalizes current Tencent descending historical output without mutating or changing prices", () => {
  // Live unadjusted observations match Eastmoney fqt=0. Default qfq closes were 365.68/369.19.
  const rows = [
    {
      date: "2026-01-06",
      open: 380,
      last: 373.99,
      high: 380.5,
      low: 369.04,
      volume: 341477,
      amount: 12764800000,
    },
    {
      date: "2026-01-05",
      open: 370,
      last: 377.5,
      high: 378,
      low: 368.19,
      volume: 336881,
      amount: 12583420000,
    },
  ];
  const bars = parseTencentChart(rows, "sz300750", "day");
  expect(bars.map((b) => [b.date, b.close])).toEqual([
    ["2026-01-05", 377.5],
    ["2026-01-06", 373.99],
  ]);
  expect(rows[0]?.date).toBe("2026-01-06");
});
it("rejects the real two-byte 7709 response instead of fabricating 800 candles", () => {
  expect(() => parseBars(Buffer.from("2003", "hex"), "day")).toThrow(
    "只有数量字段",
  );
  expect(parseBars(Buffer.from("0000", "hex"), "day")).toEqual([]);
});

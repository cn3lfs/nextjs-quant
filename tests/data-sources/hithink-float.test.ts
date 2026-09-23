import { afterEach, expect, it, vi } from "vitest";
import {
  floatEvidence,
  floatFromEvidence,
  queryFloat,
} from "../../src/server/data-sources/hithink/hithink-float";
const raw = {
  status_code: 0,
  datas: [{ 股票代码: "600519.SH", "流通市值[20260908]": 200e8 }],
  columns: [{ key: "流通市值[20260908]", unit: "元", timestamp: "20260908" }],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("preserves a usable base observation without inventing event adjustments", () => {
  const evidence = floatEvidence("sh600519", raw, "2026-09-08", "query", 1);
  expect(floatFromEvidence("sh600519", "2026-09-08", evidence)).toMatchObject({
    basePoints: 5,
    points: 0,
    status: "missing",
    floatMarketCapYi: 200,
  });
  expect(() => floatFromEvidence("sz000001", "2026-09-08", evidence)).toThrow(
    "身份",
  );
  expect(() => floatFromEvidence("sh600519", "2026-09-07", evidence)).toThrow(
    "日期",
  );
  expect(() =>
    floatFromEvidence("sh600519", "2026-09-08", {
      ...evidence,
      text: evidence.text + " ",
    }),
  ).toThrow("指纹");
});
it("queries the exact security and date, deduplicates concurrent requests and checks cancellation", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw)));
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    queryFloat("sh600519", "2026-09-08"),
    queryFloat("sh600519", "2026-09-08"),
  ]);
  expect(a.id).toBe(b.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const init = fetcher.mock.calls[0]![1] as RequestInit;
  expect(JSON.parse(init.body as string).query).toBe(
    "600519.SH 20260908 流通市值",
  );
  expect((init.headers as Record<string, string>)["X-Claw-Skill-Id"]).toBe(
    "hithink-basicinfo-query",
  );
  expect(() =>
    queryFloat("sh600519", "2026-09-08", AbortSignal.abort()),
  ).toThrow();
  expect(() => queryFloat("sh600519", "2026-02-30")).toThrow("日期");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

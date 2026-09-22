import { afterEach, expect, it, vi } from "vitest";
import {
  queryInstitutions,
  institutionsEvidence,
} from "../src/server/data-sources/hithink/hithink-institutions";
const raw = { status_code: 0, datas: [{ 股票代码: "600519.SH" }], columns: [] };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("uses management headers and preserves missing fields rather than fabricating scores", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "test-placeholder");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw)));
  vi.stubGlobal("fetch", fetcher);
  const evidence = await queryInstitutions("sh600519");
  expect(evidence.envelope?.source).toBe("hithink-management-query");
  expect(JSON.parse(evidence.text).diagnostic.status).toBe("missing");
  const options = fetcher.mock.calls[0]![1];
  expect(options.headers["X-Claw-Skill-Id"]).toBe("hithink-management-query");
  expect(options.headers["X-Claw-Trace-Id"]).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(options.body).query).toContain("600519.SH");
});
it("limits empty-result rewrites and does not retry authentication failures", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "test-placeholder");
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ status_code: 0, datas: [] })),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(queryInstitutions("sh600519")).rejects.toThrow("三次");
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockClear();
  fetcher.mockResolvedValue(new Response("", { status: 401 }));
  await expect(queryInstitutions("sh600519")).rejects.toThrow("失败");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects cross-security data and already cancelled queries", async () => {
  expect(() => institutionsEvidence("sh600000", raw, "query", 1)).toThrow(
    "身份",
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(() => queryInstitutions("sh600519", AbortSignal.abort())).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

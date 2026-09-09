import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  request: vi.fn(),
}));
vi.mock("../src/server/db", () => ({
  get: (id: string) => state.records.get(id),
  put: (_kind: string, id: string, value: unknown) =>
    state.records.set(id, value),
}));
vi.mock("../src/server/hithink-context", () => ({ request: state.request }));
import { queryRsEvidence } from "../src/server/hithink-rs";
const key = "涨跌幅[20260616-20260908]";
const raw = {
  status_code: 0,
  code_count: 2,
  columns: [
    {
      key,
      timestamp: "20260616-20260908",
      unit: "%",
      type: "DOUBLE",
      sort_info: "desc",
    },
  ],
  datas: [
    { 股票代码: "600519.SH", [key]: 20 },
    { 股票代码: "000001.SZ", [key]: 10 },
  ],
};
afterEach(() => {
  state.records.clear();
  state.request.mockReset();
  vi.unstubAllEnvs();
});
it("shares one full universe request and isolates an individual cancellation", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  let complete!: (value: unknown) => void;
  state.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const controller = new AbortController();
  const first = queryRsEvidence("sh600519", controller.signal);
  const rejected = expect(first).rejects.toThrow();
  const second = queryRsEvidence("sz000001");
  controller.abort();
  complete(raw);
  await rejected;
  expect(JSON.parse((await second).text)).toMatchObject({
    symbol: "sz000001",
    percentile: 0,
  });
  expect(state.request).toHaveBeenCalledTimes(1);
  await queryRsEvidence("sh600519");
  expect(state.request).toHaveBeenCalledTimes(1);
});
it("aborts abandoned work, rejects late cache writes, and permits a new request", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  let complete!: (value: unknown) => void;
  let sharedSignal!: AbortSignal;
  state.request.mockImplementation((_skill, _query, signal) => {
    sharedSignal = signal;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const controller = new AbortController();
  const first = queryRsEvidence("sh600519", controller.signal);
  const rejected = expect(first).rejects.toThrow();
  controller.abort();
  await rejected;
  expect(sharedSignal.aborted).toBe(true);
  complete(raw);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.records.size).toBe(0);
  state.request.mockResolvedValue(raw);
  await queryRsEvidence("sh600519");
  expect(state.request).toHaveBeenCalledTimes(2);
});

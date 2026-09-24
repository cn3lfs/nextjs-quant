import { expect, it } from "vitest";
import { rateGate } from "../../src/server/infra/rate-gate";

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

it("串行执行并按最小间隔加抖动排开", async () => {
  const c = clock();
  const gate = rateGate({ minIntervalMs: 500, jitterMs: 500, random: () => 0.5, ...c });
  const starts: number[] = [];
  let running = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      gate(async () => {
        running++;
        expect(running).toBe(1);
        starts.push(c.now());
        await Promise.resolve();
        running--;
      }),
    ),
  );
  expect(starts).toEqual([0, 750, 1500]);
});

it("每分钟上限在滚动窗口内生效", async () => {
  const c = clock();
  const gate = rateGate({ minIntervalMs: 0, perMinute: 2, ...c });
  const starts: number[] = [];
  for (let i = 0; i < 3; i++) await gate(async () => starts.push(c.now()));
  expect(starts).toEqual([0, 0, 60000]);
});

it("取消排队中的任务不影响后续任务", async () => {
  const gate = rateGate({ minIntervalMs: 0 });
  let unblock!: () => void;
  const first = gate(() => new Promise<void>((r) => (unblock = r)));
  const controller = new AbortController();
  const second = gate(async () => "never", controller.signal);
  controller.abort();
  await expect(second).rejects.toThrow("任务已取消");
  unblock();
  await first;
  await expect(gate(async () => "ok")).resolves.toBe("ok");
});

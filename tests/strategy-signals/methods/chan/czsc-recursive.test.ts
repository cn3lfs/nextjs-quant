import { beforeAll, afterAll, it, expect } from "vitest";
import { prepareCzscTestRuntime } from "../../../helpers/czsc-runtime";
import {
  analyzeCzsc,
  closeCzsc,
  projectCzsc,
} from "../../../../src/server/strategies/chan/czsc";
import fixture from "../../../fixtures/czsc-sse.json";
beforeAll(prepareCzscTestRuntime);
afterAll(closeCzsc);
it("round trips explicit daily anchor through serial native owner", async () => {
  const bars = fixture.date.slice(0, 150).map((date, i) => ({
    date,
    open: fixture.close[i]!,
    close: fixture.close[i]!,
    high: fixture.high[i]!,
    low: fixture.low[i]!,
    volume: fixture.volume[i]!,
    amount: 0,
  }));
  const result = await analyzeCzsc(bars, true, projectCzsc, true, 1);
  expect(result.families[0]!.native!.recursive!.anchor).toBe(1);
  expect(result.families[0]!.native!.recursive!.nodes.length).toBeGreaterThan(
    0,
  );
});

it("rejects missing anchor, daily relabelled as minutes, illegal output and minute window", async () => {
  const input = {
    high: [11, 11, 11],
    low: [9, 9, 9],
    close: [10, 10, 10],
    volume: [100, 100, 100],
  };
  await expect(projectCzsc(input, [0], [93])).rejects.toThrow("显式锚");
  await expect(
    projectCzsc(
      {
        ...input,
        anchor: 2,
        dates: ["2020-01-01", "2020-01-02", "2020-01-03"],
      },
      [0],
      [93],
    ),
  ).rejects.toThrow("五分钟");
  await expect(
    projectCzsc(
      {
        ...input,
        anchor: 2,
        dates: [
          "2023-01-03T09:35:00+08:00",
          "2023-01-03T09:40:00+08:00",
          "2023-01-03T09:45:00+08:00",
        ],
      },
      [0],
      [93],
    ),
  ).rejects.toThrow("窗口");
  await expect(projectCzsc(input, [0], [109])).rejects.toThrow(
    "Invalid CZSC output",
  );
});
it("keeps independent concurrent anchor/config jobs atomic and decodes a real five-minute table", async () => {
  const input = {
    high: [11, 11, 11, 13, 14, 15, 15, 15],
    low: [9, 9, 9, 12, 13, 13, 13, 13],
    close: [10, 10, 10, 12.5, 13.5, 14, 14, 14],
    volume: Array(8).fill(100),
  };
  const dates = input.high.map(
    (_, i) =>
      `2020-01-02T${i < 5 ? "09" : "10"}:${String((35 + i * 5) % 60).padStart(2, "0")}:00+08:00`,
  );
  const outputs = [93, 94, 95, 96, 97, 98, 99];
  const [a, b] = await Promise.all([
    projectCzsc({ ...input, anchor: 2, dates }, [0], outputs),
    projectCzsc(
      {
        ...input,
        anchor: 1,
        dates: input.high.map(
          (_, i) => `2020-01-${String(i + 1).padStart(2, "0")}`,
        ),
      },
      [1100],
      outputs,
    ),
  ]);
  expect(a.projections["0:95:0:11"]!.at(-1)).toBe(2);
  expect(b.projections["1100:95:0:11"]!.at(-1)).toBe(1);
  const { decodeCzscRecursive } =
    await import("../../../../src/server/strategies/chan/czsc-structures");
  const table = decodeCzscRecursive(a, 0, 8, 2);
  expect(table.nodes[0]!.completed).toBe(4);
  expect(table.transitions.find((t) => t.variant === 1)?.ended).not.toBeNull();
  const damaged = structuredClone(a);
  damaged.projections["0:95:0:0"]![7] = -1;
  expect(() => decodeCzscRecursive(damaged, 0, 8, 2)).toThrow("结构缺口");
  const badReference = structuredClone(a);
  badReference.projections["0:97:0:1"]![7] = 16777216;
  expect(() => decodeCzscRecursive(badReference, 0, 8, 2)).toThrow("结构缺口");
  const missing = structuredClone(a);
  delete missing.projections["0:95:0:16"];
  expect(() => decodeCzscRecursive(missing, 0, 8, 2)).toThrow("结构缺口");
});

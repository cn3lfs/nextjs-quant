import { expect, it, vi } from "vitest";
import type { CzscResult } from "../../src/lib/research/methods/chan/czsc";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchSignals } from "../../src/server/strategies/shared/research-signals";

const bars = Array.from({ length: 65 }, (_, i) => ({
  date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 100,
  amount: 1000,
}));
const spec = researchSpecSchema.parse({
  strategy: "czsc",
  start: bars[61]!.date,
  end: bars[63]!.date,
  validationStart: bars[63]!.date,
});
const result = (signal: boolean): CzscResult => ({
  status: "structure",
  hash: "dll",
  sourceCommit: "b67f3c6",
  families: [
    {
      config: 0,
      points: [],
      centers: [],
      movements: [],
      qualities: [],
      divergences: [],
      signals: signal
        ? [{ index: 30, date: bars[30]!.date, kind: 3, quality: 1 }]
        : [],
    },
  ],
});

it("labels a historical endpoint on its actual confirmation date and ignores later bars", async () => {
  const engine = vi.fn(async (prefix: Readonly<typeof bars>) =>
    result(prefix.length >= 63),
  );
  const events = await researchSignals("sh600000", bars, spec, engine);
  expect(engine.mock.calls.map(([prefix]) => prefix.length)).toEqual([
    61, 62, 63, 64,
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    endpointDate: bars[30]!.date,
    observedDate: bars[62]!.date,
    partition: "development",
  });
  const revised = structuredClone(bars);
  revised[64]!.close = 100;
  expect(await researchSignals("sh600000", revised, spec, engine)).toEqual(
    events,
  );
});

it("does not re-emit signals already known before the research range", async () => {
  expect(
    await researchSignals("sh600000", bars, spec, async () => result(true)),
  ).toEqual([]);
  await expect(
    researchSignals(
      "sh600000",
      bars,
      spec,
      async () => result(false),
      () => true,
    ),
  ).rejects.toThrow("取消");
});

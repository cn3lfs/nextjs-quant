import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { researchCanslimVolumeScore } from "trading-strategies/research/canslim/research-canslim-volume-score";

const bars = (): Bar[] =>
  Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: i === 65 ? 150 : 100,
    amount: 1000,
  }));

it("scores exactly 1.5 times as eight, keeps five-day peak separate from today's volume and rearms", () => {
  const input = bars();
  const result = researchCanslimVolumeScore(input);
  expect(result[64]!.diagnostic.points).toBe(0);
  expect(result[65]!.diagnostic).toMatchObject({
    points: 8,
    mean20: 100,
    peak5: 150,
  });
  expect(result[65]!.entry).toBe(true);
  expect(
    result.slice(66, 70).map((p) => [p.entry, p.diagnostic.points]),
  ).toEqual(Array.from({ length: 4 }, () => [false, 8]));
  expect(result[70]!.diagnostic.points).toBe(0);
  input[65]!.volume = 149.999;
  expect(researchCanslimVolumeScore(input).some((p) => p.entry)).toBe(false);
  input[65]!.volume = 150;
  input[76]!.volume = 200;
  expect(
    researchCanslimVolumeScore(input)
      .filter((p) => p.entry)
      .map((p) => p.date),
  ).toEqual([input[65]!.date, input[76]!.date]);
});

it("rejects unknown previous score, incomplete calendar, zero volume and invalid OHLC without backfilling", () => {
  const input = bars();
  input[24]!.volume = 150;
  expect(researchCanslimVolumeScore(input)[24]).toMatchObject({
    entry: false,
    diagnostic: { points: 8, previousPoints: null },
  });
  for (const patch of [
    { volume: 0 },
    { volume: NaN },
    { high: 8 },
    { close: Infinity },
  ]) {
    const broken = bars();
    Object.assign(broken[55]!, patch);
    expect(researchCanslimVolumeScore(broken)[65]).toMatchObject({
      entry: false,
      diagnostic: { status: "missing", points: null },
    });
  }
  const missing = bars();
  missing.splice(55, 1);
  expect(
    researchCanslimVolumeScore(
      missing,
      bars().map((b) => b.date),
    ).find((p) => p.date === input[65]!.date)!.entry,
  ).toBe(false);
  const full = researchCanslimVolumeScore(input);
  for (const end of [25, 65, 66, 70])
    expect(researchCanslimVolumeScore(input.slice(0, end))).toEqual(
      full.slice(0, end),
    );
  input[75]!.volume = 100000;
  expect(researchCanslimVolumeScore(input).slice(0, 75)).toEqual(
    full.slice(0, 75),
  );
});

it("keeps the volume rule source snapshot", () => {
  const input = bars();
  const spec = researchSpecSchema.parse({
    strategy: "canslim-volume-entry-binary",
    symbols: ["sh600000"],
    start: input[61]!.date,
    end: input[79]!.date,
    validationStart: input[77]!.date,
    holdingDays: 2,
  });
  expect(JSON.stringify(researchMethodSnapshot(spec))).toContain(
    "canslim-analyst/SKILL.md",
  );
});

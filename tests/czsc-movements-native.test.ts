import { beforeAll, afterAll, expect, it } from "vitest";
import { prepareCzscTestRuntime } from "./helpers/czsc-runtime";
import {
  analyzeChanMovements,
  closeCzsc,
} from "../src/server/strategies/chan/czsc";
import { chanC4Observations } from "../src/lib/research-chan-movements";
import type { ChanAnchor } from "../src/lib/czsc-movements";
import fixture from "./fixtures/czsc-sse.json";
import { writeFileSync } from "node:fs";

beforeAll(prepareCzscTestRuntime);
const coverage: unknown[] = [];
afterAll(async () => {
  await closeCzsc();
  if (process.env.C5_NATIVE_REPORT)
    writeFileSync(
      process.env.C5_NATIVE_REPORT,
      JSON.stringify(coverage, null, 2),
    );
});

it.each([1, 2, 3] as ChanAnchor[])(
  "real C4 DLL: anchor %s every prefix, both configs, members/108/revisions",
  async (anchor) => {
    const bars = fixture.date.slice(0, 150).map((date, i) => ({
      date:
        anchor === 1
          ? date
          : anchor === 3
            ? new Date(Date.UTC(2000, i + 1, 0)).toISOString().slice(0, 10)
            : `2020-01-${String(2 + Math.floor(i / 48)).padStart(2, "0")}T${String(Math.floor((i % 48 < 24 ? 575 + (i % 48) * 5 : 785 + ((i % 48) - 24) * 5) / 60)).padStart(2, "0")}:${String((i % 48 < 24 ? 575 + (i % 48) * 5 : 785 + ((i % 48) - 24) * 5) % 60).padStart(2, "0")}:00+08:00`,
      open: fixture.close[i]!,
      close: fixture.close[i]!,
      high: fixture.high[i]!,
      low: fixture.low[i]!,
      volume: fixture.volume[i]!,
      amount: 0,
    }));
    const ledgers = [
      chanC4Observations("real-c4-fixture"),
      chanC4Observations("real-c4-fixture"),
    ];
    const totals = {
      prefixes: 0,
      tables: 0,
      centers: 0,
      movements: 0,
      links: 0,
      unknown: 0,
      verified: 0,
      revised: 0,
      candidates: 0,
      confirmed: 0,
    };
    for (let n = 1; n <= bars.length; n++) {
      const prefix = bars.slice(0, n),
        result = await analyzeChanMovements(prefix, anchor);
      totals.prefixes++;
      expect(result.hash).toBe(
        "7f2b2ec4703ed67c811046d0b2b73a1f40b6266cd3abaeb2620e2ece47e77457",
      );
      for (const [i, family] of result.families.entries()) {
        const table = family.native!.recursiveMovements!;
        expect(table.anchor).toBe(anchor);
        expect(table.config).toBe(family.config);
        totals.tables++;
        totals.centers += table.centers.length;
        totals.movements += table.movements.length;
        totals.links += table.connections.length;
        for (const association of table.associations) {
          if (association.status === "verified") totals.verified++;
          else {
            totals.unknown++;
            expect(association.level).toBeNull();
          }
        }
        for (const row of ledgers[i]!(prefix, table)) {
          if (row.state === "revised") totals.revised++;
          if (row.state === "candidate") totals.candidates++;
          if (row.state === "confirmed") totals.confirmed++;
          expect(row.candidateAt <= row.observedAt).toBe(true);
          if (row.confirmedAt)
            expect(row.confirmedAt <= row.observedAt).toBe(true);
        }
      }
    }
    expect(totals.tables).toBe(300);
    expect(totals.centers).toBeGreaterThan(0);
    expect(totals.links).toBeGreaterThan(0);
    expect(totals.revised).toBeGreaterThan(0);
    coverage.push({
      anchor,
      ...totals,
      note: "relabelled OHLC fixture tests ABI, not historical monthly/minute coverage",
    });
  },
  120000,
);

it.each([1, -1])(
  "real DLL classifies completed %s multi-center movement, not a direction label",
  async (direction) => {
    const high = [12, 13, 12, 16, 17, 17, 17, 21, 22],
      low = [10, 11, 10, 15, 15, 15, 15, 20, 20];
    const bars = high.map((h, i) => ({
      date: `2020-01-${String(i + 1).padStart(2, "0")}`,
      high: direction === 1 ? h : 40 - low[i]!,
      low: direction === 1 ? low[i]! : 40 - h,
      open: direction === 1 ? h : 40 - h,
      close: direction === 1 ? h : 40 - h,
      volume: 100,
      amount: 1000,
    }));
    const result = await analyzeChanMovements(bars, 1);
    for (const f of result.families) {
      const table = f.native!.recursiveMovements!;
      expect(
        table.movements.some(
          (m) =>
            m.type === direction &&
            m.centerIds.length >= 2 &&
            m.completed !== null,
        ),
      ).toBe(true);
      const early = await analyzeChanMovements(bars.slice(0, 3), 1);
      expect(
        early.families
          .find((x) => x.config === f.config)!
          .native!.recursiveMovements!.movements.every(
            (m) => m.completed === null,
          ),
      ).toBe(true);
    }
  },
);

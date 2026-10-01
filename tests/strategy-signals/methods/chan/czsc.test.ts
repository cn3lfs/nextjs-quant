import { beforeAll, afterAll, expect, test } from "vitest";
import { prepareCzscTestRuntime } from "../../../helpers/czsc-runtime";
import fixture from "../../../fixtures/czsc-sse.json";
import {
  projectCzsc,
  closeCzsc,
  analyzeCzsc,
  analyzeChanMovements,
  czscConfigOptions,
} from "../../../../src/server/strategies/chan/czsc";
import {
  czscCodes,
  defaultCzscSettings,
} from "../../../../src/lib/chart/czsc-settings";
import {
  chanC4Sequence,
  chanC4Trend,
} from "../../../../src/lib/research/methods/chan/research-chan-movements";
import { chanRecursiveObservations } from "../../../../src/lib/research/methods/chan/research-chan-recursive";
import { parseBars } from "../../../../src/server/data-sources/tdx/tdx";
import { toFloat32 } from "../../../../src/server/strategies/chan/czsc-input";
import { readFileSync } from "node:fs";
import {
  CZSC_FLAG_EVENTS,
  CZSC_FLAG_HIGHER,
} from "../../../../src/server/strategies/chan/czsc-api";

beforeAll(prepareCzscTestRuntime);
afterAll(closeCzsc);

test("api v7 chart settings: option table drives codes; defaults stay 0/1100", async () => {
  const options = await czscConfigOptions();
  expect(options).toHaveLength(16);
  const at = (place: number) => options.filter((o) => o.place === place);
  expect(at(1).map((o) => o.value)).toEqual([0, 1, 2, 3, 4]);
  expect(at(1).find((o) => o.value === 3)).toMatchObject({
    original: 0,
    lessons: "",
  });
  for (const place of [1, 10, 100, 1000, 10000, 100000])
    expect(at(place).filter((o) => o.isDefault)).toHaveLength(1);
  expect(czscCodes(defaultCzscSettings)).toEqual({ 0: 0, 1100: 1100 });
  const bars = fixture.high.map((high, i) => ({
    date: new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10),
    open: fixture.close[i]!,
    high,
    low: fixture.low[i]!,
    close: fixture.close[i]!,
    volume: fixture.volume[i]!,
    amount: 0,
  }));
  const codes = czscCodes({
    stroke: 3,
    strokeEnd: 1,
    segment: 0,
    segmentEnd: 2,
    centerMode: 0,
  });
  expect(codes).toEqual({ 0: 13, 1100: 113 });
  const result = await analyzeCzsc(
    bars,
    false,
    undefined,
    false,
    undefined,
    false,
    codes,
  );
  expect(result.families.map((f) => [f.config, f.code])).toEqual([
    [0, 13],
    [1100, 113],
  ]);
  for (const f of result.families)
    for (const c of f.centers) expect(c.boxEnd).toBeLessThanOrEqual(c.end);
  // v8 segment boundary: display-only; heuristic segments ignore the digit.
  const base = await analyzeCzsc(bars);
  for (const segmentEnd of [1, 2]) {
    const c = czscCodes({ ...defaultCzscSettings, segmentEnd });
    expect(c).toEqual({ 0: 0, 1100: 1100 + 10000 * segmentEnd });
    const shown = await analyzeCzsc(
      bars,
      false,
      undefined,
      false,
      undefined,
      false,
      c,
    );
    const [low, high] = shown.families;
    expect(low!.points).toEqual(base.families[0]!.points);
    expect(high!.points).toHaveLength(base.families[1]!.points.length);
    // SSE: first-stroke moves 3 of 11 segment endpoints, last-stroke moves 1.
    expect(
      high!.points.filter(
        (q, i) => q.index !== base.families[1]!.points[i]!.index,
      ),
    ).toHaveLength(segmentEnd === 1 ? 3 : 1);
    expect(high!.centers).toEqual(base.families[1]!.centers);
    expect(high!.signals).toEqual(base.families[1]!.signals);
    expect(high!.divergences).toEqual(base.families[1]!.divergences);
  }
  // v9 parent-segment stroke centers (czsc-tdx v5 reply: SSE 14 -> 18 with
  // feature segments); segment centers keep the entering rule.
  const mode = czscCodes({ ...defaultCzscSettings, centerMode: 1 });
  expect(mode).toEqual({ 0: 101000, 1100: 1100 });
  const parent = await analyzeCzsc(
    bars,
    false,
    undefined,
    false,
    undefined,
    false,
    mode,
  );
  expect(base.families[0]!.centers).toHaveLength(14);
  expect(parent.families[0]!.centers).toHaveLength(18);
  expect(parent.families[0]!.points).toEqual(base.families[0]!.points);
  expect(parent.families[1]).toEqual(base.families[1]);
  await expect(projectCzsc(fixture, [2000])).rejects.toThrow(
    "Unsupported CZSC config 2000",
  );
  await expect(
    analyzeCzsc(bars, true, undefined, true, undefined, false, codes),
  ).rejects.toThrow("研究结构锁定配置0/1100");
});

test("runtime preparation preserves a DLL already loaded by the serial owner", async () => {
  const before = await projectCzsc(fixture);
  await prepareCzscTestRuntime();
  expect(await projectCzsc(fixture)).toEqual(before);
});

test("concurrent jobs preserve each input's C/V and config projections", async () => {
  const other = {
    high: fixture.high.slice(0, 650),
    low: fixture.low.slice(0, 650),
    close: fixture.close.slice(0, 650),
    volume: fixture.volume.slice(0, 650).map((v) => v * 2),
  };
  const inputs = [fixture, other, { ...fixture, close: fixture.low }];
  const serial = [];
  for (const input of inputs) serial.push(await projectCzsc(input));
  expect(await Promise.all(inputs.map((input) => projectCzsc(input)))).toEqual(
    serial,
  );
});

test("insufficient bars return explicit no-structure without artificial endpoints", async () => {
  for (const length of [0, 1, 2, 3]) {
    const bars = fixture.date.slice(0, length).map((date, i) => ({
      date,
      open: fixture.close[i]!,
      high: fixture.high[i]!,
      low: fixture.low[i]!,
      close: fixture.close[i]!,
      volume: fixture.volume[i]!,
      amount: 0,
    }));
    const result = await analyzeCzsc(bars);
    expect(result.status).toBe("no-structure");
    for (const f of result.families) {
      expect([
        f.points,
        f.centers,
        f.signals,
        f.movements,
        f.qualities,
        f.divergences,
      ]).toEqual([[], [], [], [], [], []]);
    }
  }
});

test("three local unadjusted TDX snapshots produce structured results without source writes", async () => {
  for (const symbol of ["sh600519", "sz002084", "bj920748"]) {
    const path = `E:/new_tdx64/vipdoc/${symbol.slice(0, 2)}/lday/${symbol}.day`;
    const bytes = readFileSync(path);
    const bars = parseBars(bytes, "day");
    const result = await analyzeCzsc(bars);
    expect(result.status).toBe("structure");
    expect(result.families.map((f) => f.config)).toEqual([0, 1100]);
    for (const f of result.families) {
      expect(f.points.every((p) => p.date === bars[p.index]!.date)).toBe(true);
      expect(
        f.centers.every(
          (c) =>
            c.start < c.end && c.ZG >= c.ZD && c.GG >= c.ZG && c.DD <= c.ZD,
        ),
      ).toBe(true);
      expect(f.signals.every((s) => [1, 2, 3].includes(Math.abs(s.kind)))).toBe(
        true,
      );
      expect(f.qualities).toHaveLength(f.signals.length);
    }
    expect(readFileSync(path)).toEqual(bytes);
    console.log(
      "LOCAL CZSC",
      symbol,
      bars.length,
      result.families.map((f) => ({
        config: f.config,
        points: f.points.length,
        centers: f.centers.length,
        signals: f.signals.length,
      })),
    );
  }
});

test("float32 conversion rejects invalid values and preserves rounding", () => {
  expect(toFloat32([3128.72])[0]).toBe(Math.fround(3128.72));
  expect(() => toFloat32([Infinity])).toThrow();
  expect(() => toFloat32([1e40])).toThrow();
});

// Upstream golden (czsc-tdx tests/unit/golden/sse.txt) is rendered from H/L
// only, so MACD uses the engine's (H+L)/2 proxy; feed exactly that as close.
test("SSE daily matches the upstream czsc-tdx golden for configs 0 and 1100", async () => {
  expect(fixture.date).toHaveLength(2038);
  const close = fixture.high.map((h, i) =>
    Math.fround(
      Math.fround(Math.fround(h) + Math.fround(fixture.low[i]!)) * 0.5,
    ),
  );
  const input = { ...fixture, close };
  const raw = await projectCzsc(input, [0, 1100], CZSC_FLAG_EVENTS);
  const name = (t: number) =>
    `${["一", "二", "三"][Math.abs(t) - 1]}${t > 0 ? "买" : "卖"}`;
  const date = (i: number) => fixture.date[i] ?? "?";
  const golden = readFileSync("tests/fixtures/czsc-sse-golden.txt", "utf8")
    .replace(/\r/g, "")
    .split(/\n\n/)
    .filter(Boolean);
  for (const config of [0, 1100]) {
    const f = raw.families[config]!;
    const hindsight = f.signals.filter((s) => s.hindsight === 1);
    const lines = [
      `## 配置 ${config}：端点 ${f.pivots.length}，中枢 ${f.centers.length}，走势 ${f.movements.length}，事后信号 ${hindsight.length}，当下事件 ${f.events.length}`,
      ...f.centers.map(
        (c, i) =>
          `中枢 ${date(c.start)}~${date(c.end)} ZG ${c.zg.toFixed(2)} ZD ${c.zd.toFixed(2)} GG ${c.gg.toFixed(2)} DD ${c.dd.toFixed(2)} 方向 ${c.direction}${i === 0 ? "" : c.relationToPrev === 1 ? " 上涨" : c.relationToPrev === -1 ? " 下跌" : " 扩展"}`,
      ),
      ...f.movements
        .filter((m) => m.type !== 0)
        .map(
          (m) =>
            `趋势 ${m.type > 0 ? "上涨" : "下跌"} ${date(m.start)}~${date(m.end)} 中枢 ${m.firstCenter}-${m.lastCenter}`,
        ),
      ...hindsight.map((s) => `事后 ${name(s.type)} ${date(s.index)}`),
      ...f.events.map((e) => {
        const s = f.signals[e.signal]!;
        return `当下 ${e.op > 0 ? "出现" : "失效"} ${name(s.type)} ${date(s.index)} 于 ${date(e.bar)} 失效价 ${s.stop.toFixed(2)}`;
      }),
    ];
    const expected = golden
      .find((block) => block.startsWith(`## 配置 ${config}：`))!
      .trim()
      .split("\n");
    expect(lines).toEqual(expected);
  }
  // api v6: the DLL names its clean source commit; centers carry their
  // formation bar; bars carry the MA5/MA20 pair the kisses use.
  expect(raw.buildCommit).toBe("ab31cce06a63");
  const native = raw.families[0]!;
  for (const c of native.centers)
    expect(c.established).toBe(native.pivots[c.firstPivot + 3]!.fractalAt);
  const average = (period: number) => {
    let sum = 0;
    return close.map((v, i) => {
      sum = Math.fround(sum + v);
      if (i >= period) sum = Math.fround(sum - close[i - period]!);
      return Math.fround(sum / Math.min(i + 1, period));
    });
  };
  expect(native.bars.map((b) => [b.maShort, b.maLong])).toEqual(
    average(5).map((v, i) => [v, average(20)[i]]),
  );
  // The v5 recursion section is rendered with the sample's real close/volume.
  const recursive = (await projectCzsc(fixture, [0], CZSC_FLAG_HIGHER))
    .families[0]!;
  const date2 = (i: number) => (i >= 0 ? (fixture.date[i] ?? "?") : "?");
  expect([
    `## 递归 配置 0：节点 ${recursive.nodes.length}，上层中枢 ${recursive.recursiveCenters.length}，上层连接段 ${recursive.connections.length}`,
    ...recursive.movements.flatMap((m, i) =>
      m.successor < 0
        ? []
        : [
            `中阴 走势${i} ${date2(m.zhongyinStart)}~${date2(m.successorEstablishedAt)}`,
          ],
    ),
    ...recursive.nodes
      .filter((n) => n.level > 0)
      .map(
        (n) =>
          `节点 L${n.level}#${n.ordinal} 类型 ${n.type} ${date2(n.start)}~${date2(n.end)} 高 ${n.high.toFixed(2)} 低 ${n.low.toFixed(2)} 中枢 ${n.firstCenter}-${n.lastCenter} 子 ${n.childCount} 中阴 ${date2(n.zhongyinStart)}~${date2(n.completed)} 定型 ${date2(n.confirmedAt)}`,
      ),
    ...recursive.recursiveCenters.map(
      (c) =>
        `上层中枢 L${c.level}#${c.ordinal} ${date2(c.start)}~${date2(c.end)} ZG ${c.zg.toFixed(2)} ZD ${c.zd.toFixed(2)} GG ${c.gg.toFixed(2)} DD ${c.dd.toFixed(2)} 方向 ${c.direction} 成员 ${c.firstMember}+${c.memberCount} 成立 ${date2(c.established)} 定型 ${date2(c.confirmedAt)}`,
    ),
    ...recursive.connections.map(
      (k) =>
        `连接段 L${k.level}#${k.ordinal} ${date2(k.start)}~${date2(k.end)} 成员 ${k.firstMember}+${k.memberCount} 定型 ${date2(k.confirmedAt)}`,
    ),
  ]).toEqual(
    golden
      .find((block) => block.startsWith("## 递归 配置 0："))!
      .trim()
      .split("\n"),
  );
  // Decoding keeps the same objects and one-based center ownership.
  const bars = fixture.date.map((d, i) => ({
    date: d,
    open: close[i]!,
    high: fixture.high[i]!,
    low: fixture.low[i]!,
    close: close[i]!,
    volume: fixture.volume[i]!,
    amount: 0,
  }));
  const result = await analyzeCzsc(bars, true);
  const low = result.families[0]!;
  expect(low.centers).toHaveLength(14);
  expect(low.signals.map((s) => `${s.date}:${s.kind}`)).toEqual(
    raw.families[0]!.signals.filter((s) => s.hindsight === 1)
      .sort((a, b) => a.index - b.index)
      .map((s) => `${fixture.date[s.index]}:${s.type}`),
  );
  const first = low.signals.find((s) => s.date === "2018-08-20")!;
  expect(first.kind).toBe(1);
  expect(low.centers[first.centerId! - 1]!.startDate).toBe("2018-07-06");
  expect(first.confirmedAt).toBe(fixture.date.indexOf("2018-11-20"));
  expect(first.stop).toBe(Math.fround(2653.11));
});

test("anchored C4 and zhongyin tables decode from api v5 and prove the trend-ending first-class points", async () => {
  const bars = fixture.date.map((date, i) => ({
    date,
    open: fixture.close[i]!,
    close: fixture.close[i]!,
    high: fixture.high[i]!,
    low: fixture.low[i]!,
    volume: fixture.volume[i]!,
    amount: 0,
  }));
  const result = await analyzeChanMovements(bars, 1);
  const family = result.families[0]!;
  const table = family.native!.recursiveMovements!;
  // Level 0 = strokes between adjacent endpoints; level 1 = configured-level movements.
  expect(table.movements.filter((m) => m.level === 0)).toHaveLength(157);
  expect(table.movements.filter((m) => m.level === 1)).toHaveLength(10);
  expect(chanC4Sequence(table, 1).status).toBe("ready");
  expect(
    family.signals
      .filter((s) => Math.abs(s.kind) === 1)
      .map((s) => [s.date, chanC4Trend(result, bars, 0, s).action]),
  ).toEqual([
    ["2018-08-20", "enter"],
    ["2019-04-08", "exit"],
    ["2021-02-18", "exit"],
  ]);
  const recursive = family.native!.recursive!;
  expect(
    recursive.transitions
      .filter((t) => t.variant === 1)
      .map((t) => `${bars[t.entered]!.date}~${bars[t.ended!]!.date}`)
      .slice(0, 2),
  ).toEqual(["2018-10-22~2018-11-20", "2019-05-13~2019-06-03"]);
  expect(
    chanRecursiveObservations("sse")
      .observe(bars, recursive)
      .map((o) => o.kind),
  ).toContain("zhongyin-structural-end");
});

test("the worker ships only the tables a caller needs", async () => {
  const lean = (await projectCzsc(fixture, [0], 0, false, false)).families[0]!;
  expect([lean.bars, lean.events, lean.nodes]).toEqual([[], [], []]);
  expect(lean.signals.length).toBeGreaterThan(0);
  const full = (
    await projectCzsc(fixture, [0], CZSC_FLAG_EVENTS | CZSC_FLAG_HIGHER)
  ).families[0]!;
  expect(full.bars).toHaveLength(fixture.high.length);
  expect(full.events.length).toBeGreaterThan(0);
  expect(full.nodes.length).toBeGreaterThan(0);
  // Structure and signals do not depend on which tables were shipped.
  expect(lean.signals).toEqual(full.signals);
  expect(lean.centers).toEqual(full.centers);
});

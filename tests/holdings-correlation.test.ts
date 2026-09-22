import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  holdingsCorrelation,
  type HoldingsCorrelationInput,
} from "../src/lib/holdings-correlation";
import {
  holdingsCorrelationPageSchema,
  pageHoldingsCorrelation,
} from "../src/server/portfolio/holdings-correlation-service";
import { HoldingsCorrelationResults } from "../src/components/holdings-correlation-results";
const dates = Array.from({ length: 32 }, (_, i) =>
  new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
);
function prices(values: number[]) {
  let close = 100;
  return [
    { date: dates[0]!, close },
    ...values.map((r, i) => ({ date: dates[i + 1]!, close: (close *= 1 + r) })),
  ];
}
function fixture(n = 20): HoldingsCorrelationInput {
  const x = Array.from({ length: n }, (_, i) => (i % 2 ? 0.01 : -0.01));
  return {
    tradingDays: dates,
    days: dates.slice(1, n + 1).map((date) => ({
      date,
      positions: { sh600000: 1, sz000001: 2, sh600001: 3 },
    })),
    bars: {
      sh600000: prices(x),
      sz000001: prices(x.map((v) => 2 * v)),
      sh600001: prices(x.map((v) => -v)),
    },
  };
}
it("手算正负相关、对称与对角线；另构造正交三标的", () => {
  const result = holdingsCorrelation(fixture());
  // x=±.01，y=2x，z=-x：Σxy/sqrt(Σx²Σy²)=1，x-z=-1。
  expect(result.matrix[0]![2]!.value).toBeCloseTo(1, 12);
  expect(result.matrix[0]![1]!.value).toBeCloseTo(-1, 12);
  result.matrix.forEach((row, i) =>
    row.forEach((v, j) => {
      expect(v).toEqual(result.matrix[j]![i]);
      if (i === j) expect(v.value).toBe(1);
    }),
  );
  const input = fixture();
  // x=(-1,1,-1,1)*.01，z=(-1,-1,1,1)*.01，各重复5次；均值0，Σxz=0。
  input.bars = {
    ...input.bars,
    sh600001: prices(
      Array.from({ length: 20 }, (_, i) => (i % 4 < 2 ? -0.01 : 0.01)),
    ),
  };
  expect(holdingsCorrelation(input).matrix[0]![1]!.value).toBeCloseTo(0, 12);
});
it.each([19, 20, 21])("%i 日门槛", (n) => {
  const cell = holdingsCorrelation(fixture(n)).matrix[0]![2]!;
  expect(cell.overlapDays).toBe(n);
  if (n < 20)
    expect(cell).toEqual({
      value: null,
      reason: "重叠交易日不足 20，相关性不可靠",
      overlapDays: 19,
    });
  else expect(cell.value).toBeCloseTo(1, 12);
});
it("成对完整，不跨缺价日；结果等于手工先剔除再算", () => {
  const input = fixture(25);
  input.bars = {
    ...input.bars,
    sh600000: input.bars.sh600000!.filter(
      (b) => b.date !== dates[5] && b.date !== dates[10],
    ),
  };
  const cell = holdingsCorrelation(input).matrix[0]![2]!;
  // 两个缺价各损失当日及下一日收益：25-4=21，剩余y=2x，Pearson=1。
  expect(cell.overlapDays).toBe(21);
  expect(cell.value).toBeCloseTo(1, 12);
  expect(holdingsCorrelation(input).matrix[1]![2]!.overlapDays).toBe(25);
});
it("仓位变动不影响相关性，逆回购不进入集合", () => {
  const input = fixture();
  const original = holdingsCorrelation(input);
  // positionValues随数量变动，不是价格收益；设置为抛错getter证明未读取它。
  input.days = input.days.map((day, i) => ({
    ...day,
    positions: {
      sh600000: i + 1,
      sz000001: 100 - i,
      sh600001: 3,
      sh204001: 1000,
    },
    get positionValues(): never {
      throw new Error("禁止读取仓位市值");
    },
  }));
  expect(holdingsCorrelation(input)).toEqual(original);
});
it("无收益整行整列为空、零方差与空集合留空，不进平均", () => {
  const input = fixture();
  input.bars = { ...input.bars, sh600001: [] };
  const result = holdingsCorrelation(input);
  expect(result.matrix[1]!.every((v) => v.value === null)).toBe(true);
  expect(result.pairCount).toEqual({ available: 1, insufficient: 2 });
  expect(result.averagePairwise.value).toBeCloseTo(1, 12);
  input.bars = { ...input.bars, sz000001: prices(Array(20).fill(0)) };
  expect(holdingsCorrelation(input).matrix[0]![2]!.reason).toContain("零方差");
  expect(
    holdingsCorrelation({ ...input, days: [] }).averagePairwise.value,
  ).toBeNull();
});
it("110标的服务端分页仅返回10×110，翻页与排序不影响摘要，渲染不出现全矩阵", () => {
  const input = fixture();
  const symbols = Array.from({ length: 110 }, (_, i) => `sh${600000 + i}`);
  input.days = input.days.map((d) => ({
    ...d,
    positions: Object.fromEntries(symbols.map((s) => [s, 1])),
  }));
  input.bars = Object.fromEntries(
    symbols.map((s) => [s, input.bars.sh600000!]),
  );
  const page = holdingsCorrelationPageSchema.parse({});
  const a = pageHoldingsCorrelation(input, page),
    b = pageHoldingsCorrelation(input, { ...page, pageIndex: 1 });
  expect(a.rows).toHaveLength(10);
  expect(a.symbols).toHaveLength(110);
  expect(a.rows[0]!.cells).toHaveLength(110);
  expect(b.rows[0]!.symbol).toBe(symbols[10]);
  expect(b.averagePairwise).toEqual(a.averagePairwise);
  expect(a.pairCount).toEqual({ available: 5995, insufficient: 0 });
  expect(
    pageHoldingsCorrelation(input, { ...page, desc: true }).rows[0]!.symbol,
  ).toBe(symbols.at(-1));
  expect(
    pageHoldingsCorrelation(input, { ...page, pageIndex: 11 }).rows,
  ).toEqual([]);
  expect(() => holdingsCorrelationPageSchema.parse({ pageSize: 21 })).toThrow();
  const html = renderToStaticMarkup(
    createElement(HoldingsCorrelationResults, {
      data: a,
      table: {
        pagination: page,
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
    }),
  );
  expect(
    html.match(/<tbody[\s\S]*?<\/tbody>/)?.[0].match(/<tr/g) ?? [],
  ).toHaveLength(10);
  expect(html).toContain("两者都低才是真分散");
  expect(html).toContain("等效持仓只数越大");
});

it("非完全相关用手工成对剔除样本核对；缺价不能污染其他证券对", () => {
  const input = fixture(25);
  const x = Array.from({ length: 25 }, (_, i) => ((i % 5) - 2) / 100);
  const y = Array.from({ length: 25 }, (_, i) => ((i % 3) - 1) / 100);
  input.bars = {
    ...input.bars,
    sh600000: prices(x).filter((b) => b.date !== dates[5]),
    sz000001: prices(y),
  };
  // 删除第5和第6个收益，使用 Σxy - ΣxΣy/n 形式独立手算协方差与方差。
  const keep = x.map((_, i) => i).filter((i) => i !== 4 && i !== 5);
  const n = keep.length;
  const sx = keep.reduce((s, i) => s + x[i]!, 0),
    sy = keep.reduce((s, i) => s + y[i]!, 0);
  const xy = keep.reduce((s, i) => s + x[i]! * y[i]!, 0) - (sx * sy) / n;
  const xx = keep.reduce((s, i) => s + x[i]! ** 2, 0) - sx ** 2 / n;
  const yy = keep.reduce((s, i) => s + y[i]! ** 2, 0) - sy ** 2 / n;
  const cell = holdingsCorrelation(input).matrix[0]![2]!;
  expect(cell.overlapDays).toBe(23);
  expect(cell.value).toBeCloseTo(xy / Math.sqrt(xx * yy), 12);
});
it("非法或重复价格不补零，区间之外的收益不计样本", () => {
  const input = fixture(25);
  const bars = [...input.bars.sh600000!, input.bars.sh600000![5]!];
  input.bars = {
    ...input.bars,
    sh600000: bars.map((b) => (b.date === dates[10] ? { ...b, close: 0 } : b)),
  };
  expect(holdingsCorrelation(input).matrix[0]![2]!.overlapDays).toBe(21);
  expect(
    holdingsCorrelation({ ...fixture(25), days: fixture(25).days.slice(0, 19) })
      .matrix[0]![2]!.value,
  ).toBeNull();
});

it("U5嵌入集中度同卡，导入撤销刷新使相关性缓存失效", () => {
  const parent = readFileSync(
    "src/components/trade-review-container.tsx",
    "utf8",
  );
  expect(parent).toContain("utils.tradeReviewHoldingsCorrelation.invalidate()");
  const container = readFileSync(
    "src/components/position-risk-container.tsx",
    "utf8",
  );
  expect(container).toMatch(
    /<PositionRiskResults[\s\S]*<HoldingsCorrelationContainer account=\{account\} \/>[\s\S]*<\/PositionRiskResults>/,
  );
  const result = readFileSync(
    "src/components/position-risk-results.tsx",
    "utf8",
  );
  expect(result.indexOf("{children}")).toBeGreaterThan(
    result.indexOf("summary.medianEffectivePositions?.toFixed(2)"),
  );
});

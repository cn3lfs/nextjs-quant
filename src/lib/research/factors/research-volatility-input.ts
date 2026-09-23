import { z } from "zod";
import type { Bar } from "../../domain";

const positive = z.number().finite().positive();
const stamp = z.string().datetime({ offset: true });
const coefficient = z
  .object({
    sigma: z.number().finite().min(0),
    // External provider's evaluated skew correction in price units; never an invented formula.
    skewCorrection: z.number().finite(),
  })
  .strict();
export const volatilityInputSchema = z
  .object({
    symbol: z.string().regex(/^(sh|sz)\d{6}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().trim().min(1),
    version: z.string().trim().min(1),
    effectiveAt: stamp,
    availableAt: stamp,
    capturedAt: stamp,
    kase: z
      .object({
        formulaReference: z.string().trim().min(1),
        window: z.number().int().min(2).max(120),
        anchor: positive,
        warning: coefficient,
        levels: z.tuple([coefficient, coefficient, coefficient]),
        // Cumulative original-position fractions. They are frozen at entry for staged exits.
        cumulativeFractions: z.tuple([
          positive.max(1),
          positive.max(1),
          z.literal(1),
        ]),
      })
      .strict()
      .refine(
        (v) =>
          v.cumulativeFractions[0] < v.cumulativeFractions[1] &&
          v.cumulativeFractions[1] < 1,
        "累计减仓比例须递增至1",
      )
      .optional(),
    beta: z
      .object({
        value: z.number().finite(),
        estimationWindow: z.number().int().min(2),
        benchmark: z.string().trim().min(1),
        windowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        price: positive,
        tableReference: z.string().trim().min(1),
        table: z
          .array(
            z
              .object({
                betaMin: z.number().finite(),
                betaMax: z.number().finite(),
                priceMin: z.number().finite().min(0),
                priceMax: positive,
                distance: positive,
              })
              .strict()
              .refine((v) => v.betaMin < v.betaMax && v.priceMin < v.priceMax),
          )
          .min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export const volatilityInputsSchema = z
  .array(volatilityInputSchema)
  .max(100000);
export type VolatilityInput = z.infer<typeof volatilityInputSchema>;
export type ExternalVolatilityId = "rk-kase" | "rk-kase-stages" | "rk-beta";
export function isExternalVolatility(id: string): id is ExternalVolatilityId {
  return ["rk-kase", "rk-kase-stages", "rk-beta"].includes(id);
}
export const volatilityInputBoundary =
  "待数据v1：Kase需逐证券逐日来源/版本/公式引用、窗口、锚点及预警与三级sigma系数和外部已求值偏度修正（价格单位），本地只计算两根TR样本标准差并应用参数，绝不补造完整DevStop公式。Beta需估计窗口/基准/截止日及版本化价格×Beta查表，区间左闭右开，零或多重匹配均missing。输入effectiveAt/availableAt/capturedAt均不得晚于观察日15:00+08:00，拒绝事后补录。阶段比例在入场前冻结，累计原始数量目标，等号触发，跳过多档时取最深目标，受阻不撤单，只按实际已卖数量扣减。预警仅记录，三级全清；初始保护使用输入第三级/Beta线并据此缩股；持仓保持旧保护线，不放宽。缺输入真实回测不可用；固定输入不是盈利证据。";

export function externalVolatilityPoint(
  id: ExternalVolatilityId,
  bars: readonly Bar[],
  symbol: string,
  date: string,
  inputs: readonly VolatilityInput[] = [],
  calendar: readonly string[] = bars.map((b) => b.date),
):
  | { status: "missing"; reason: string }
  | {
      status: "available";
      stop: number;
      warning: number | null;
      levels: number[];
      cumulativeFractions: number[];
      evidence: VolatilityInput;
    } {
  const missing = (reason: string) => ({ status: "missing" as const, reason });
  const cutoff = Date.parse(`${date}T15:00:00+08:00`);
  const rows = inputs.filter((v) => v.symbol === symbol && v.date === date);
  if (rows.length !== 1) return missing("缺唯一的当日外部波动参数输入");
  const parsed = volatilityInputSchema.safeParse(rows[0]);
  if (!parsed.success) return missing("外部波动参数结构非法或缺必需字段");
  const e = parsed.data;
  if (
    !Number.isFinite(cutoff) ||
    [e.effectiveAt, e.availableAt, e.capturedAt].some(
      (t) => Date.parse(t) > cutoff,
    ) ||
    Date.parse(e.effectiveAt) > Date.parse(e.availableAt) ||
    Date.parse(e.availableAt) > Date.parse(e.capturedAt)
  )
    return missing("外部参数未在当时生效/可知/采集，不能回填历史");
  if (id === "rk-beta") {
    const b = e.beta;
    if (!b || b.windowEnd > date)
      return missing("缺Beta估计口径、截至时点或原查表");
    if (bars.find((row) => row.date === date)?.close !== b.price)
      return missing("Beta价格档输入与当日收盘价格不一致");
    const matches = b.table.filter(
      (r) =>
        b.value >= r.betaMin &&
        b.value < r.betaMax &&
        b.price >= r.priceMin &&
        b.price < r.priceMax,
    );
    if (matches.length !== 1)
      return missing("Beta/价格查表未唯一覆盖，禁止插值或最近档替代");
    const stop = b.price - matches[0]!.distance;
    return stop > 0
      ? {
          status: "available",
          stop,
          warning: null,
          levels: [],
          cumulativeFractions: [],
          evidence: e,
        }
      : missing("Beta查表止损非正");
  }
  const k = e.kase;
  if (!k) return missing("缺Kase完整公式引用及已求值偏度修正参数");
  const prefix = bars.filter((b) => b.date <= date).slice(-(k.window + 2));
  const dates = calendar.filter((d) => d <= date).slice(-(k.window + 2));
  if (
    prefix.length !== k.window + 2 ||
    prefix.at(-1)?.date !== date ||
    prefix.some(
      (b, i) =>
        b.date !== dates[i] ||
        ![b.open, b.high, b.low, b.close, b.volume].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        b.high < Math.max(b.open, b.close) ||
        b.low > Math.min(b.open, b.close),
    )
  )
    return missing("Kase两根TR统计窗口缺失或行情非法");
  const ranges = prefix
    .slice(2)
    .map(
      (b, i) =>
        Math.max(b.high, prefix[i + 1]!.high, prefix[i]!.close) -
        Math.min(b.low, prefix[i + 1]!.low, prefix[i]!.close),
    );
  const mean = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const sigma = Math.sqrt(
    ranges.reduce((a, b) => a + (b - mean) ** 2, 0) / (ranges.length - 1),
  );
  const distances = [k.warning, ...k.levels].map(
    (c) => c.sigma * sigma + c.skewCorrection,
  );
  if (
    distances.some(
      (v, i) =>
        !Number.isFinite(v) ||
        v <= 0 ||
        v >= k.anchor ||
        (i > 0 && v <= distances[i - 1]!),
    )
  )
    return missing("Kase预警/三级修正距离须为正且严格递增、止损价为正");
  const lines = distances.map((d) => k.anchor - d);
  return {
    status: "available",
    stop: lines[3]!,
    warning: lines[0]!,
    levels: lines.slice(1),
    cumulativeFractions: k.cumulativeFractions,
    evidence: e,
  };
}

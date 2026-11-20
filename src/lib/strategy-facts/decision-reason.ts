import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";

type DecisionEvidence = {
  kind: string;
  close: number;
  volume: number;
  entry: boolean | null;
  inputs: Record<string, unknown>;
  rps?: readonly { period: number; actual: unknown }[];
};
export type DecisionReasonContext = {
  rankScore?: number | null;
  regime?: {
    trend: boolean | null;
    breadth: number | null;
    coverage: number | null;
    effect?: string;
  } | null;
  targetWeight?: number;
  currentWeight?: number;
  deltaWeight?: number;
  marketLowZone?: {
    index: string;
    depth: number | null;
    breadth: number | null;
    coverage: { prices: number | null; pe: number | null; pb: number | null };
    synthetic: {
      pe: number | null;
      pb: number | null;
      pePercentile: number | null;
      pbPercentile: number | null;
    };
    confidence: string;
  } | null;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const rows = (value: unknown) =>
  Array.isArray(value) ? value.map(record) : [];
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const number = (value: unknown, digits = 4) =>
  formatNumber(finite(value), digits);
const percent = (value: unknown) => {
  const actual = finite(value);
  return formatPercent(actual === null ? null : actual * 100, 1);
};
const condition = (value: unknown) =>
  value === true || value === "是"
    ? "通过"
    : value === false || value === "否"
      ? "未通过"
      : "未知";

function priceEvidence(input: Record<string, unknown>) {
  return (
    [
      ["stopPrice", "止损"],
      ["targetPrice", "目标"],
    ] as const
  ).flatMap(([key, label]) =>
    finite(input[key]) === null ? [] : [`${label} ${number(input[key])}`],
  );
}

/** Display recorded rule inputs. Unknown values stay unknown; raw formulas,
 * internal object layouts and unsampled conditions are not a user-facing why. */
export function strategyDecisionReason(
  evidence: DecisionEvidence | null | undefined,
  context: DecisionReasonContext = {},
) {
  const parts: string[] = [];
  if (!evidence) parts.push("规则输入缺失，入选依据待核验");
  else {
    const input = evidence.inputs;
    parts.push(`入场条件${condition(evidence.entry)}`);
    parts.push(`信号收盘 ${number(evidence.close)}`);
    if (evidence.kind === "dual-ma") {
      parts.push(
        `MA${number(input.fast, 0)} ${number(input.short)}（前值 ${number(input.previousShort)}） / MA${number(input.slow, 0)} ${number(input.long)}（前值 ${number(input.previousLong)}）`,
      );
      const signal = { BUY: "均线上穿", SELL: "均线下穿", HOLD: "本根未交叉" };
      if (typeof input.signal === "string" && input.signal in signal)
        parts.push(signal[input.signal as keyof typeof signal]);
    } else if (evidence.kind === "formula") {
      const parameters = Object.entries(record(input.parameters)).filter(
        ([, value]) => finite(value) !== null,
      );
      if (parameters.length)
        parts.push(
          `参数 ${parameters
            .slice(0, 4)
            .map(([key, value]) => `${key}=${number(value)}`)
            .join(" / ")}`,
        );
      const dependencies = rows(input.dependencies).filter(
        (row) => typeof row.expression === "string",
      );
      if (dependencies.length)
        parts.push(
          dependencies
            .slice(0, 4)
            .map((row) => `${String(row.expression)}=${number(row.value)}`)
            .join(" / "),
        );
      const outputs = rows(input.outputs).filter(
        (row) => typeof row.name === "string",
      );
      if (outputs.length)
        parts.push(
          outputs
            .slice(0, 2)
            .map((row) => `${String(row.name)}=${number(row.value)}`)
            .join(" / "),
        );
      if (!dependencies.length) parts.push("公式依赖值未记录");
      parts.push(`成交量 ${number(evidence.volume, 0)}（行情口径）`);
    } else if (evidence.kind === "double-breakout") {
      const checks = record(input.checks);
      parts.push(
        `趋势线 ${number(record(input.line).value)} / 关键位 ${number(record(input.keyLevel).price)} / 量比 ${number(input.volumeRatio, 2)} / 20期均量 ${number(input.volume20, 0)}`,
      );
      parts.push(
        (
          [
            ["trend", "趋势"],
            ["level", "关键位"],
            ["volume", "量能"],
            ["indicators", "指标"],
            ["candle", "K线"],
          ] as const
        )
          .map(([key, label]) => `${label}${condition(checks[key])}`)
          .join(" / "),
      );
      if (input.direction === "long") parts.push("方向 向上");
      if (input.direction === "short") parts.push("方向 向下");
      parts.push(...priceEvidence(input));
    } else if (evidence.kind === "pattern-breakout") {
      const matches = rows(input.matches).filter(
        (match) => typeof match.label === "string",
      );
      for (const match of matches) {
        const detail = [String(match.label)];
        if (finite(match.score) !== null)
          detail.push(`评分 ${number(match.score, 0)}/5`);
        if (finite(match.pivotPrice) !== null)
          detail.push(`突破位 ${number(match.pivotPrice)}`);
        if (finite(match.volumeRatio) !== null)
          detail.push(`量比 ${number(match.volumeRatio, 2)}`);
        detail.push(...priceEvidence(match));
        parts.push(detail.join(" / "));
      }
      if (!matches.length)
        parts.push(
          Array.isArray(input.matches) && !input.matches.length
            ? "当根无匹配形态突破"
            : "形态突破明细未记录",
        );
    } else if (evidence.kind === "czsc-monitor") {
      const fresh = rows(input.fresh);
      const level =
        input.config === 0 ? "笔" : input.config === 1100 ? "段" : "";
      for (const signal of fresh) {
        const kind = finite(signal.kind);
        let label = "缠论买卖点";
        if (typeof signal.shortLabel === "string") label = signal.shortLabel;
        else if (typeof signal.label === "string") label = signal.label;
        else if (typeof signal.code === "string") label = signal.code;
        else if (kind)
          label = `${level}${Math.abs(kind)}${kind > 0 ? "买" : "卖"}`;
        const detail = [label];
        if (typeof signal.endpointDate === "string")
          detail.push(`端点 ${signal.endpointDate}`);
        if (finite(signal.quality) !== null)
          detail.push(`质量 ${number(signal.quality, 0)}`);
        detail.push(...priceEvidence(signal));
        parts.push(detail.join(" / "));
      }
      if (!fresh.length) {
        if (input.baseline === true) parts.push("缠论买卖点建立观察基线");
        else if (Array.isArray(input.fresh)) parts.push("当根无新增缠论买卖点");
        else parts.push("缠论买卖点明细未记录");
      }
    } else if (evidence.kind === "chan-third-buy") {
      const firstIndex = finite(record(input.rule).firstIndex);
      parts.push(
        firstIndex === null
          ? "缠论三买"
          : `缠论三买 / 首个评估K线索引 ${number(firstIndex, 0)}`,
      );
    } else if (evidence.kind === "rps") {
      parts.push(
        `RPS${number(input.period, 0)} ${number(record(input.actual).rps, 1)} / 门槛 ${number(input.minimum, 1)}`,
      );
    } else if (input.lowZone) {
      const low = record(input.lowZone);
      parts.push(
        `低位深度 ${number(low.depth, 0)} / 价格分位 ${percent(record(low.price).value)} / 回撤 ${percent(record(low.drawdown).value)}`,
      );
    } else if (evidence.kind === "constant") {
      parts.push("固定观察规则，需结合排序与组合准入");
    } else if (!context.marketLowZone) parts.push("本条规则的条件明细未记录");
    if (evidence.rps?.length)
      parts.push(
        evidence.rps
          .map((row) => `RPS${row.period} ${number(record(row.actual).rps, 1)}`)
          .join(" / "),
      );
  }
  if (context.rankScore !== undefined)
    parts.push(`排序分 ${number(context.rankScore, 3)}`);
  if (context.regime) {
    const gate = context.regime;
    parts.push(
      `市场${gate.effect === "exposure-switch" ? "仓位开关" : "准入"}：趋势${condition(gate.trend)} / 广度 ${percent(gate.breadth)} / 覆盖 ${percent(gate.coverage)}`,
    );
  }
  if (context.targetWeight !== undefined)
    parts.push(
      `目标 ${percent(context.targetWeight)} / 现有 ${percent(context.currentWeight)} / 变动 ${percent(context.deltaWeight)}`,
    );
  if (context.marketLowZone) {
    const low = context.marketLowZone;
    parts.push(
      `${low.index} 低位深度 ${number(low.depth, 0)} / 低位广度 ${percent(low.breadth)} / 价格覆盖 ${percent(low.coverage.prices)}`,
    );
    parts.push(
      `合成PE ${number(low.synthetic.pe, 2)}（分位 ${percent(low.synthetic.pePercentile)}，覆盖 ${percent(low.coverage.pe)}） / PB ${number(low.synthetic.pb, 2)}（分位 ${percent(low.synthetic.pbPercentile)}，覆盖 ${percent(low.coverage.pb)}）`,
    );
    if (low.confidence === "current-labelled-diagnostic")
      parts.push("当前成分回看，含前视偏差");
  }
  return parts.join("；");
}

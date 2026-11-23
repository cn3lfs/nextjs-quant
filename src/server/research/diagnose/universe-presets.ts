export const CORE_5_SYMBOLS = Object.freeze([
  "sh600519",
  "sz000001",
  "sh601318",
  "sz000333",
  "sz300750",
] as const);

export const CORE_12_SYMBOLS = Object.freeze([
  ...CORE_5_SYMBOLS,
  "sz300308",
  "sh688981",
  "sz300274",
  "sz002594",
  "sh600276",
  "sh601899",
  "sz000858",
] as const);

export const CHAN_CORE_7_SYMBOLS = Object.freeze([
  ...CORE_5_SYMBOLS,
  "sh688981",
  "sz300308",
] as const);

type Symbol = (typeof CORE_12_SYMBOLS)[number];
type SymbolMetadata = Readonly<{
  group: "基线回归" | "理论扩展";
  name: string;
  board: string;
  role: string;
}>;
const metadata = {
  sh600519: {
    group: "基线回归",
    name: "贵州茅台",
    board: "主板",
    role: "长历史回归与缠论三买性能对拍",
  },
  sz000001: {
    group: "基线回归",
    name: "平安银行",
    board: "主板",
    role: "周末与基准日历外日期回归",
  },
  sh601318: {
    group: "基线回归",
    name: "中国平安",
    board: "主板",
    role: "大盘金融蓝筹低弹性对照",
  },
  sz000333: {
    group: "基线回归",
    name: "美的集团",
    board: "主板",
    role: "稳健制造消费蓝筹对照",
  },
  sz300750: {
    group: "基线回归",
    name: "宁德时代",
    board: "创业板",
    role: "高成长与 gpcw20251231.dat 重复财报披露",
  },
  sz300308: {
    group: "理论扩展",
    name: "中际旭创",
    board: "创业板",
    role: "业绩爆发期 CANSLIM 与 SEPA 验证",
  },
  sh688981: {
    group: "理论扩展",
    name: "中芯国际",
    board: "科创板",
    role: "晚上市、20% 涨跌幅与组合 firstIndex 对齐",
  },
  sz300274: {
    group: "理论扩展",
    name: "阳光电源",
    board: "创业板",
    role: "强趋势、VCP 与回撤退出验证",
  },
  sz002594: {
    group: "理论扩展",
    name: "比亚迪",
    board: "主板（原中小板）",
    role: "大周期反转与高成长验证",
  },
  sh600276: {
    group: "理论扩展",
    name: "恒瑞医药",
    board: "主板",
    role: "长跌转震荡与威科夫吸筹回调验证",
  },
  sh601899: {
    group: "理论扩展",
    name: "紫金矿业",
    board: "主板",
    role: "资源周期与威科夫趋势回调验证",
  },
  sz000858: {
    group: "理论扩展",
    name: "五粮液",
    board: "主板",
    role: "与贵州茅台同业对照及组合竞仓验证",
  },
} as const satisfies Record<Symbol, SymbolMetadata>;

export type UniversePresetId = "core-5" | "core-12" | "chan-core-7";

function preset<Id extends UniversePresetId, S extends Symbol>(
  id: Id,
  label: string,
  symbols: readonly S[],
) {
  const entries = symbols.map((symbol): [S, SymbolMetadata] => [
    symbol,
    Object.freeze(metadata[symbol]),
  ]);
  return Object.freeze({
    id,
    label,
    symbols,
    metadata: Object.freeze(Object.fromEntries(entries)) as Readonly<
      Record<S, SymbolMetadata>
    >,
    survivorBiasDisclosure:
      "预先指定的现存标的分层验证池，存在幸存者偏差与人为选样偏差。未覆盖退市股票、历史全市场成分及完整历史 ST 状态，结果仅供规则自检。",
  });
}

export const UNIVERSE_PRESETS = Object.freeze({
  "core-5": preset("core-5", "五股回归基线", CORE_5_SYMBOLS),
  "core-12": preset("core-12", "十二股分层验证池", CORE_12_SYMBOLS),
  "chan-core-7": preset("chan-core-7", "七股缠论验证池", CHAN_CORE_7_SYMBOLS),
});

export function resolveUniversePreset(name: string) {
  if (!Object.hasOwn(UNIVERSE_PRESETS, name))
    throw new Error(
      `未知诊断证券池：${name}（可选 ${Object.keys(UNIVERSE_PRESETS).join("、")}）`,
    );
  return UNIVERSE_PRESETS[name as UniversePresetId];
}

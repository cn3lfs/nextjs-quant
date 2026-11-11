export const classicIds = [
  "classic-connors-rsi",
  "classic-ibs",
  "classic-stoch-rsi",
  "classic-kama",
  "classic-aroon",
  "classic-trix",
  "classic-force-index",
  "classic-nvi",
  "classic-coppock",
  "classic-vortex",
] as const;
export type ClassicId = (typeof classicIds)[number];
const lean =
  "https://github.com/QuantConnect/Lean/blob/054ec0596a66f0ad09ca5101df424cf6697060a7/Indicators/";
const definitions = [
  {
    id: "classic-connors-rsi",
    name: "Connors RSI中点反转基线",
    family: "反转",
    warmupBars: 101,
    source: "ConnorsRelativeStrengthIndex.cs",
    rule: "CRSI=(RSI3收盘+RSI2连续涨跌长度+本根收益相对此前100个真实单根收益的严格小于百分位)/3；CRSI<50入场，>50退出；中点反转为本地系统基线，不是原作者超卖阈值系统。",
  },
  {
    id: "classic-ibs",
    name: "IBS日内强度反转基线",
    family: "反转",
    warmupBars: 0,
    source: "InternalBarStrength.cs",
    rule: "IBS=(收盘-最低)/(最高-最低)，零振幅为0.5；IBS<0.5入场，>0.5退出。本地中点反转基线，收盘后确认，不假设日内成交。",
  },
  {
    id: "classic-stoch-rsi",
    name: "Stochastic RSI双线基线",
    family: "动量",
    warmupBars: 31,
    source: "StochasticRelativeStrengthIndex.cs",
    rule: "RSI14经14根极差归一为0至100，再SMA3得K、SMA3得D；K>D入场，K<D退出。有效RSI窗口零极差按源定义取100；未预热RSI不填零。",
  },
  {
    id: "classic-kama",
    name: "KAMA自适应趋势基线",
    family: "趋势",
    warmupBars: 10,
    source: "KaufmanAdaptiveMovingAverage.cs",
    rule: "效率比=abs(C-C[-10])/近10根abs价差和；SC=(ER×(2/3-2/31)+2/31)^2，KAMA递推；完整10价差起算，以此前收盘作种子。C>KAMA入场，C<KAMA退出。",
  },
  {
    id: "classic-aroon",
    name: "Aroon极值时距趋势基线",
    family: "趋势",
    warmupBars: 25,
    source: "AroonOscillator.cs",
    rule: "26根窗口取最近最高和最低；AroonUp=100×(25-距最高根数)/25，Down同理；Up>Down入场，反向退出。相同极值取最近。",
  },
  {
    id: "classic-trix",
    name: "TRIX三重平滑动量基线",
    family: "动量",
    warmupBars: 43,
    source: "Trix.cs",
    rule: "收盘三重EMA15的一根变化率TRIX；TRIX>0入场，<0退出。共享EMA首个有效值种子，完整43根预热，不声称与LEAN初始化逐值相同。",
  },
  {
    id: "classic-force-index",
    name: "Elder Force Index力量基线",
    family: "量价",
    warmupBars: 13,
    source: "ForceIndex.cs",
    rule: "Force=(C-C[-1])×本根成交量，EMA13平滑；Force>0入场，<0退出。单指标零轴基线，不冒称完整三重滤网系统。",
  },
  {
    id: "classic-nvi",
    name: "NVI缩量参与趋势基线",
    family: "量价",
    warmupBars: 254,
    source: null,
    rule: "NVI初值1000；仅当成交量低于前根时NVI乘C/C[-1]，否则不变；NVI>其EMA255入场，反向退出。EMA比较为本地自然趋势基线。",
  },
  {
    id: "classic-coppock",
    name: "Coppock加权动量基线",
    family: "动量",
    warmupBars: 23,
    source: "CoppockCurve.cs",
    rule: "Coppock=WMA10(ROC11+ROC14)，新值权重10、旧值权重1；>0入场，<0退出。11/14/10按交易根数日线化，不冒称原月线长周期系统。",
  },
  {
    id: "classic-vortex",
    name: "Vortex涡旋趋势基线",
    family: "趋势",
    warmupBars: 14,
    source: "Vortex.cs",
    rule: "VI+=近14根abs(H-L[-1])和/同窗TR和；VI-=近14根abs(L-H[-1])和/同窗TR和；VI+>VI-入场，反向退出，零TR窗口留空。",
  },
] as const;
export const classicDefinitions = definitions.map((d) => ({
  id: d.id,
  version: 1,
  name: d.name,
  family: d.family,
  rule: d.rule,
  warmupBars: d.warmupBars,
  origin: "international" as const,
  capabilities: ["ohlcv"] as const,
  output: "signal" as const,
  implementation: "implemented" as const,
  sources: [
    d.source
      ? lean + d.source
      : "https://github.com/bukosabino/ta/blob/a890410710a6e483c9ba08da7f3dd5089e4b9dff/ta/volume.py",
    ...(d.id === "classic-nvi"
      ? [
          "https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/negative-volume-index-nvi",
        ]
      : []),
  ],
}));

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

export type UniversePresetId =
  "core-5" | "core-12" | "chan-core-7" | "core-30-v1";

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

// Offline CLI snapshot. Rebuild using buildStratifiedCore30 with these defaults.
export const CORE_30_V1_DEFAULTS = Object.freeze({
  seed: "core-30-v1",
  developmentStart: "2018-08-22",
  gp16Date: "2018-08-21",
});
export const CORE_30_DISCLOSURE =
  "按当前存续沪深 A 股与当前行业分类抽样，存在幸存者偏差。未覆盖退市股票及完整历史 ST 状态。首根本地日线仅作上市时间代理；GP16 为当前修订文件的指定收盘日观测，缺值保留未知档。";

// symbol, display name, industry code/name, first bar, tier, GP16 (万元),
// source record byte offset, SHA-256 of the 13-byte record, missing reason.
const frozenMembers = [
  [
    "sz000571",
    "新大洲A",
    "881001",
    "煤炭",
    "1994-05-25",
    "small",
    303645.875,
    33124,
    "3cc01846464ddace101928a482a7efd97786965f8ce84ed930d7fd96d4c0892b",
    null,
  ],
  [
    "sz002554",
    "惠博普",
    "881006",
    "石油",
    "2011-02-25",
    "mid",
    342659.1875,
    82082,
    "e491a06ceac5aea83e430ea16346392b993fbc27c658b3bd16f6add755a4f771",
    null,
  ],
  [
    "sz300699",
    "光威复材",
    "881015",
    "化工",
    "2017-09-01",
    "large",
    1509536,
    141297,
    "db37771c4aafedd1fe3c7d9e0ef4ab69785bd5bab2ce64f5f7805440a946adc3",
    null,
  ],
  [
    "sz001203",
    "大中矿业",
    "881061",
    "钢铁",
    "2021-05-10",
    "unknown",
    null,
    null,
    null,
    "missing-on-date",
  ],
  [
    "sz002578",
    "闽发铝业",
    "881070",
    "有色",
    "2011-04-28",
    "small",
    351761.21875,
    9386,
    "c48144a36437f36e0292b74276e045672fad78eb0e0f2fbd74a43fddb5889496",
    null,
  ],
  [
    "sz002247",
    "聚力文化",
    "881090",
    "建材",
    "2008-06-12",
    "mid",
    597539.625,
    33657,
    "b585f9f6f2474f7f4a0146a222dad3b3b48d46650db6b6f96c1a8d976ca1a148",
    null,
  ],
  [
    "sh600195",
    "中牧股份",
    "881105",
    "农林牧渔",
    "1999-01-07",
    "large",
    729886.375,
    105001,
    "e7314904e43ef570587d0264b06583fb045559d61c12a6f8099a00888ebf5166",
    null,
  ],
  [
    "sz003000",
    "劲仔食品",
    "881129",
    "食品饮料",
    "2020-09-14",
    "unknown",
    null,
    null,
    null,
    "missing-on-date",
  ],
  [
    "sz002569",
    "*ST步森",
    "881150",
    "纺织服饰",
    "2011-04-12",
    "small",
    138189.875,
    15626,
    "36fdc65c5e26aaa0e459e1e56e1e547e3ac9de67195fe1ac2312b10c67f8ee7e",
    null,
  ],
  [
    "sz002374",
    "中锐股份",
    "881166",
    "轻工制造",
    "2010-03-18",
    "mid",
    345706.40625,
    57538,
    "f713cd971b165b735bab91dbbc41996a7df0fca104b5f1607ad6e40cb360afb3",
    null,
  ],
  [
    "sh600619",
    "海立股份",
    "881183",
    "家电",
    "1992-11-13",
    "large",
    1006653,
    53885,
    "12336ad448e530d0504a592e0bd3c444fd1e40ec39880059af327ea401b9e1de",
    null,
  ],
  [
    "sh603682",
    "锦和商管",
    "881199",
    "商贸",
    "2020-04-21",
    "unknown",
    null,
    null,
    null,
    "missing-on-date",
  ],
  [
    "sh600469",
    "风神股份",
    "881211",
    "汽车",
    "2003-10-21",
    "small",
    200781.515625,
    98826,
    "7639abf879fb34735529ae3d19a22c5fc65fc2ccdf42fa330e4aff846d3dc3c7",
    null,
  ],
  [
    "sh600351",
    "亚宝药业",
    "881230",
    "医药医疗",
    "2002-09-26",
    "mid",
    564308.75,
    109239,
    "f6058ccc2af623d7f4e53b6b037ca274dadeb6d32c10f1138f4f4d9299d6a507",
    null,
  ],
  [
    "sz300222",
    "科大智能",
    "881260",
    "电力设备",
    "2011-05-25",
    "large",
    1258940.25,
    119236,
    "880088ad30d58ba47578ae7b3c15e1c4d09f37da173a63e6b7961f5e85e7b2ce",
    null,
  ],
  [
    "sz301586",
    "佳力奇",
    "881286",
    "国防军工",
    "2024-08-28",
    "unknown",
    null,
    null,
    null,
    "missing-on-date",
  ],
  [
    "sh603029",
    "天鹅股份",
    "881292",
    "机械设备",
    "2016-04-27",
    "small",
    137396.484375,
    12090,
    "e6dcbf467c71a0e5cb381a3f43d14284c241f602f39497a2364cfed2705413f8",
    null,
  ],
  [
    "sh603386",
    "骏亚科技",
    "881318",
    "电子",
    "2017-09-12",
    "mid",
    474028.1875,
    9334,
    "c42cfdff668bb75e271c6c81074f745fb2303dde1dcb652ccda4652abe0366a1",
    null,
  ],
  [
    "sz002123",
    "梦网科技",
    "881337",
    "通信",
    "2007-03-28",
    "large",
    679288.25,
    127179,
    "f8e9272ff020e652e95b33b05273eae7095340195c91a7b839c27c2c4463ec14",
    null,
  ],
  [
    "sh688060",
    "云涌科技",
    "881351",
    "计算机",
    "2020-07-10",
    "unknown",
    null,
    null,
    null,
    "missing-on-date",
  ],
  [
    "sz300612",
    "宣亚国际",
    "881368",
    "传媒",
    "2017-02-15",
    "small",
    313956,
    51129,
    "a8c44580277f55f58b6af70bea26e045a4ecb55fcdb852b2e12dfdcaf86e0ba8",
    null,
  ],
  [
    "sh600015",
    "华夏银行",
    "881385",
    "银行",
    "2003-09-12",
    "mid",
    9488788,
    128687,
    "cbc7fcbe1a58732d294787291f86fba414c2137f020b31c102ab670a0b6a8a4e",
    null,
  ],
  [
    "sh601211",
    "国泰海通",
    "881393",
    "非银金融",
    "2015-06-26",
    "large",
    12922774,
    129532,
    "d5eaa15d74391e5a278286508c5232821bd096b4596e7493515fd0089325cc01",
    null,
  ],
  [
    "sz301038",
    "深水规院",
    "881405",
    "建筑",
    "2021-08-04",
    "unknown",
    null,
    null,
    null,
    "missing-on-date",
  ],
  [
    "sh600082",
    "ST海泰",
    "881417",
    "房地产",
    "1997-06-20",
    "small",
    301089.96875,
    4342,
    "8ce3d7fafb5b99869055be9a71ff10a6331c8d0b033784e99a63e8bba45e38d9",
    null,
  ],
  [
    "sh600593",
    "大连圣亚",
    "881426",
    "社会服务",
    "2002-07-11",
    "mid",
    314787.1875,
    6890,
    "8e0bec3e051cf835f59898a95919fc0edfba06e81cc5435374ba0063a10a05cd",
    null,
  ],
  [
    "sh603885",
    "吉祥航空",
    "881441",
    "交通运输",
    "2015-05-27",
    "large",
    2328929.5,
    125996,
    "bbff917b41e6f397f41749a09a1a7b9f88b08540a585940ac63532a2570b75ba",
    null,
  ],
  [
    "sz001248",
    "华润新能",
    "881458",
    "公用事业",
    "2026-07-02",
    "unknown",
    null,
    null,
    null,
    "missing-on-date",
  ],
  [
    "sh600796",
    "钱江生化",
    "881469",
    "环保",
    "1997-04-08",
    "small",
    183252.5,
    11401,
    "f5b01d33b1f9f84fa42cc7a9b35b4eae93627e9ea16201f699bfe99f5d05b82c",
    null,
  ],
  [
    "sz000833",
    "粤桂股份",
    "881477",
    "综合",
    "1998-11-11",
    "mid",
    346900.5625,
    19734,
    "96b4d7f95a1cf510133f9c29f79a2b13b7bcc2f0063a6a5f0e62be294b82deed",
    null,
  ],
] as const;
export const CORE_30_V1_SYMBOLS = Object.freeze(
  frozenMembers.map(([symbol]) => symbol),
);
const { developmentStart, gp16Date } = CORE_30_V1_DEFAULTS;
const overlap = CORE_12_SYMBOLS.filter((s) =>
  (CORE_30_V1_SYMBOLS as readonly string[]).includes(s),
);
const lateListedSymbols = frozenMembers
  .filter((m) => m[4] > developmentStart)
  .map((m) => m[0]);

export const CORE_30_V1_PRESET = Object.freeze({
  id: "core-30-v1" as const,
  label: "三十行业市值分层池",
  symbols: CORE_30_V1_SYMBOLS,
  ...CORE_30_V1_DEFAULTS,
  overlapWithCore12: Object.freeze({
    count: overlap.length,
    symbols: Object.freeze(overlap),
  }),
  lateListedSymbols: Object.freeze(lateListedSymbols),
  survivorBiasDisclosure:
    CORE_30_DISCLOSURE +
    ` GP16 快照日 ${gp16Date}，开发起点 ${developmentStart}；与 core-12 重叠 ${overlap.length} 股（${overlap.join("、") || "无"}）；首根日线晚于起点 ${lateListedSymbols.length} 股（${lateListedSymbols.join("、")}）。`,
  metadata: Object.freeze(
    Object.fromEntries(
      frozenMembers.map(
        ([
          symbol,
          name,
          industryCode,
          industry,
          firstBarDate,
          sizeTier,
          valueWan,
          recordOffset,
          recordSha256,
          reason,
        ]) =>
          [
            symbol,
            Object.freeze({
              name,
              industryCode,
              industry,
              firstBarDate,
              sizeTier,
              lateListed: firstBarDate > developmentStart,
              gp16: Object.freeze({
                file: `vipdoc/cw/gp${symbol}.dat`,
                date: gp16Date,
                valueWan,
                recordOffset,
                recordSha256,
                reason,
              }),
              group: industry,
              board: symbol.startsWith("sh688")
                ? "科创板"
                : symbol.startsWith("sz30")
                  ? "创业板"
                  : "主板",
              role: `市值档 ${sizeTier}，首根本地日线 ${firstBarDate}`,
            }),
          ] as const,
      ),
    ),
  ),
});

// The Lab's existing registries and symbol limits stay independent of CLI pools.
export const CLI_UNIVERSE_PRESETS = Object.freeze({
  ...UNIVERSE_PRESETS,
  "core-30-v1": CORE_30_V1_PRESET,
});

export function resolveUniversePreset(name: string) {
  if (!Object.hasOwn(CLI_UNIVERSE_PRESETS, name))
    throw new Error(
      `未知诊断证券池：${name}（可选 ${Object.keys(CLI_UNIVERSE_PRESETS).join("、")}）`,
    );
  return CLI_UNIVERSE_PRESETS[name as UniversePresetId];
}

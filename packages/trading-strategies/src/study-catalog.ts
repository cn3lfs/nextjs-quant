import {
  theoryRangeDefinitions,
  theoryRangeIds,
  theoryRangeExitRule,
  type TheoryRangeId,
} from "./theory-range.js";
import {
  theoryAdvancedDefinitions,
  theoryAdvancedIds,
  theoryAdvancedExitRule,
  type TheoryAdvancedId,
} from "./theory-advanced.js";
import {
  theoryStructureDefinitions,
  theoryStructureIds,
  theoryStructureExitRule,
  type TheoryStructureId,
} from "./theory-structure.js";
import {
  theoryDailyDefinitions,
  theoryDailyIds,
  theoryDailyExitRule,
  type TheoryDailyId,
} from "./theory-daily.js";
import {
  classicIds,
  classicDefinitions,
  type ClassicId,
} from "./classics/index.js";
import { volumeStrategies } from "./research/volume/research-volume.js";
import { wyckoffProfiles } from "./research/wyckoff/research-wyckoff.js";

export const volumeStudyBindings = {
  "research-volume-price-protected": "vp-up-expanded-confirm",
  "research-volume-flat-expanded": "vp-flat-expanded-break",
  "research-volume-up-contracted": "vp-up-contracted-confirm",
  "research-volume-down-contracted": "vp-down-contracted-confirm",
  "research-volume-up-normal": "vp-up-normal-confirm",
  "research-volume-flat-contracted": "vp-flat-contracted-break",
  "research-volume-breakout-15": "vp-breakout-1-5",
  "research-volume-breakout-20": "vp-breakout-2",
  "research-volume-average-cross": "vp-volume-ma-cross",
} as const;
export type VolumeStudyId = keyof typeof volumeStudyBindings;
const volumeStudyIds = Object.keys(volumeStudyBindings) as VolumeStudyId[];
export const isVolumeStudy = (strategy: string): strategy is VolumeStudyId =>
  Object.hasOwn(volumeStudyBindings, strategy);

export const wyckoffStudyBindings = {
  "research-wy-spring-protected": "wy-spring-daily",
  "research-wy-sos-protected": "wy-sos-daily",
  "research-wy-jac-protected": "wy-sos-jac-daily",
  "research-wy-lps-protected": "wy-lps-daily",
  "research-wy-reaccumulation-protected": "wy-reaccumulation-daily",
  "research-wy-trend-pullback-protected": "wy-trend-pullback-daily",
} as const;
export type WyckoffStudyId = keyof typeof wyckoffStudyBindings;
const wyckoffStudyIds = Object.keys(wyckoffStudyBindings) as WyckoffStudyId[];
export const isWyckoffStudy = (strategy: string): strategy is WyckoffStudyId =>
  Object.hasOwn(wyckoffStudyBindings, strategy);

export const wyckoffExitStudyBindings = {
  "research-wy-ut-exit": "wy-ut-exit-daily",
  "research-wy-sow-lpsy": "wy-sow-lpsy-daily",
  "research-wy-ice-exit": "wy-ice-exit-daily",
} as const;
export type WyckoffExitStudyId = keyof typeof wyckoffExitStudyBindings;
const wyckoffExitStudyIds = Object.keys(
  wyckoffExitStudyBindings,
) as WyckoffExitStudyId[];
export const isWyckoffExitStudy = (
  strategy: string,
): strategy is WyckoffExitStudyId =>
  Object.hasOwn(wyckoffExitStudyBindings, strategy);
export const wyckoffTrendVol10Diagnostic =
  "wy-trend-pullback-confirm-vol10-diagnostic";

/** Fixed research rules, not a ranking or optimized parameter search. */
export const classicStudyStrategies = [
  "ma",
  "breakout",
  "pullback",
  "range",
  "grid",
  "hold",
  "hold80",
] as const;
export const studyStrategies = [
  ...classicStudyStrategies,
  "research-breakout",
  "research-indicator-confluence",
  "research-volume-price",
  ...volumeStudyIds,
  "research-wyckoff",
  ...wyckoffStudyIds,
  ...wyckoffExitStudyIds,
  wyckoffTrendVol10Diagnostic,
  "research-growth",
  "sma200",
  "golden-cross",
  "ema-cross",
  "triple-ma",
  "macd",
  "dmi",
  "supertrend",
  "sar",
  "ichimoku",
  "turtle",
  "boll-breakout",
  "keltner",
  "dual-thrust",
  "momentum120",
  "momentum250",
  "skip-momentum",
  "rsi-trend",
  "rsi-reversion",
  "rsi2",
  "kdj",
  "cci",
  "williams",
  "short-reversal",
  "bias",
  "mfi",
  "obv",
  "volume-breakout",
  "cmf",
  "chandelier",
  "vol-target",
  "constant-mix",
  "cppi",
  "dca",
  "seasonal",
  "calendar-turn-of-month",
  ...classicIds,
  ...theoryDailyIds,
  ...theoryStructureIds,
  ...theoryAdvancedIds,
  ...theoryRangeIds,
] as const;
export type StudyStrategy = (typeof studyStrategies)[number];
type StudyDefinition = { name: string; family: string; rule: string };
export const studyCatalog: Record<StudyStrategy, StudyDefinition> = {
  ...(Object.fromEntries(
    theoryRangeDefinitions.map((d) => [
      d.id,
      { name: d.name, family: d.family, rule: d.rule + theoryRangeExitRule },
    ]),
  ) as Record<TheoryRangeId, StudyDefinition>),
  ...(Object.fromEntries(
    theoryAdvancedDefinitions.map((d) => [
      d.id,
      { name: d.name, family: d.family, rule: d.rule + theoryAdvancedExitRule },
    ]),
  ) as Record<TheoryAdvancedId, StudyDefinition>),
  ...(Object.fromEntries(
    theoryStructureDefinitions.map((d) => [
      d.id,
      {
        name: d.name,
        family: d.family,
        rule: d.rule + theoryStructureExitRule,
      },
    ]),
  ) as Record<TheoryStructureId, StudyDefinition>),
  ...(Object.fromEntries(
    theoryDailyDefinitions.map((d) => [
      d.id,
      { name: d.name, family: d.family, rule: d.rule + theoryDailyExitRule },
    ]),
  ) as Record<TheoryDailyId, StudyDefinition>),
  "research-wyckoff": {
    name: "SOS-JAC 突破",
    family: "wyckoff",
    rule: "复用wy-sos-daily的完整SOS候选、次日守位确认与原有日线退出；仅OHLCV工程版本，不声称完整威科夫。",
  },
  "research-wy-ut-exit": {
    name: "UT/UTAD 风险退出",
    family: "wyckoff",
    rule: "JAC 确认入场，UT/UTAD 风险确认后全平多仓。",
  },
  "research-wy-sow-lpsy": {
    name: "SOW/LPSY 反弹减半",
    family: "wyckoff",
    rule: "JAC 确认入场，SOW 后 LPSY 确认时减当时剩余多仓的 50%。",
  },
  "research-wy-ice-exit": {
    name: "破冰退出",
    family: "wyckoff",
    rule: "JAC 确认入场，收盘放量跌破此前已知冰线时全平多仓。",
  },
  [wyckoffTrendVol10Diagnostic]: {
    name: "威科夫趋势回调 · 1.0 倍量诊断敏感性",
    family: "wyckoff",
    rule: "沿用日线趋势回调候选、次日价位确认及原有退出，次日放量门槛由候选日前 20 日均量的 1.5 倍降至 1.0 倍。",
  },
  ...(Object.fromEntries(
    wyckoffStudyIds.map((id) => {
      const preset = wyckoffStudyBindings[id];
      return [
        id,
        {
          name: `${wyckoffProfiles[preset][1]} · 日线收盘保护代理`,
          family: "wyckoff",
          rule: `复用${preset}入场及结构退出。实际买入日后的第1至3根有效日线收盘跌破信号冻结低点时退出，下一合法开盘成交。按标的可用日线，不推定分钟成交或缺失行情。`,
        },
      ];
    }),
  ) as Record<WyckoffStudyId, StudyDefinition>),
  "research-growth": {
    name: "CANSLIM 98% 高点入口",
    family: "成长",
    rule: "复用canslim-high-98完整364自然日窗口上穿入口；按原研究默认固定持有5交易日后收盘请求退出、下一开盘成交，不含完整CANSLIM或财务条件。",
  },
  "research-breakout": {
    name: "双突破直接确认",
    family: "突破",
    rule: "复用sw-double-prior20完整序列：已确认60根结构的趋势线/关键位双突破且前20日均量确认；既有结构失守退出，收盘确认下一开盘。",
  },
  "research-indicator-confluence": {
    name: "多指标共振",
    family: "量价",
    rule: "复用sw-confluence五辅助确认计数的原始入场与退出序列；保留半仓/全仓入场比例，研究账本按期初本金预算。",
  },
  "research-volume-price": {
    name: "价涨量增确认",
    family: "量价",
    rule: "复用vp-up-expanded-confirm两阶段量价候选/确认及MA20失守等既有退出；相邻行情及位置证据缺失不产生信号。",
  },
  ...(Object.fromEntries(
    volumeStudyIds.map((id) => {
      const preset = volumeStudyBindings[id];
      const base = volumeStrategies[preset];
      return [
        id,
        {
          name: base.label,
          family: "量价",
          rule: `复用${preset}的日线入场与退出。实际买入后按冻结信号保护位判断收盘失守，并在下一合法开盘成交。保护适用期由预设给定；未声明保护位的预设仅用自身退出。`,
        },
      ];
    }),
  ) as Record<VolumeStudyId, StudyDefinition>),
  ...(Object.fromEntries(
    classicDefinitions.map((d) => [
      d.id,
      { name: d.name, family: d.family, rule: d.rule },
    ]),
  ) as Record<ClassicId, StudyDefinition>),
  ma: { name: "双均线5/20", family: "趋势", rule: "MA5>MA20买，MA5<MA20卖。" },
  breakout: {
    name: "唐奇安55/20",
    family: "突破",
    rule: "收盘突破此前55日高点买，跌破此前20日低点卖。",
  },
  pullback: {
    name: "趋势回调",
    family: "回调",
    rule: "C>MA120、MA20>MA60、C<MA20且RSI6<40买；RSI6>70、C<MA120或成交价下8%卖。",
  },
  range: {
    name: "布林均值回归",
    family: "反转",
    rule: "MA60的20日变化绝对值≤3%且触及BOLL20下轨买；回中轨、持20日或亏8%卖。",
  },
  grid: {
    name: "60%底仓+网格",
    family: "仓位",
    rule: "初始80%投入，成交股数75%作为底仓；相对实际成交复权锚点±4%买卖100股，机动仓上限为初始两倍。",
  },
  hold: {
    name: "买入持有100%",
    family: "基准",
    rule: "期初一次投入100%，不复投分红。",
  },
  hold80: {
    name: "买入持有80%",
    family: "基准",
    rule: "期初一次投入80%，保留现金，不再平衡。",
  },
  sma200: {
    name: "200日均线择时",
    family: "趋势",
    rule: "C>MA200买，C<MA200卖。",
  },
  "golden-cross": {
    name: "黄金交叉50/200",
    family: "趋势",
    rule: "MA50>MA200买，MA50<MA200卖。",
  },
  "ema-cross": {
    name: "EMA12/26趋势",
    family: "趋势",
    rule: "EMA12>EMA26买，反向卖。",
  },
  "triple-ma": {
    name: "三均线20/60/120",
    family: "趋势",
    rule: "MA20>MA60>MA120买；MA20<MA60或C<MA120卖。",
  },
  macd: {
    name: "MACD12/26/9",
    family: "趋势",
    rule: "DIF>DEA且DIF>0买；DIF<DEA卖。",
  },
  dmi: {
    name: "DMI/ADX14",
    family: "趋势",
    rule: "+DI>-DI且ADX>25买；+DI<-DI或ADX<20卖。Wilder平滑。",
  },
  supertrend: {
    name: "Supertrend10×3",
    family: "趋势",
    rule: "Supertrend多头状态买，空头状态卖；ATR10用共享算术均值。",
  },
  sar: {
    name: "抛物线SAR",
    family: "趋势",
    rule: "SAR多头买，空头卖；AF从0.02递增至0.20。",
  },
  ichimoku: {
    name: "一目均衡9/26/52",
    family: "趋势",
    rule: "C在26日前计算的云层之上且转换线>基准线买；C跌破云底或转换线<基准线卖。",
  },
  turtle: {
    name: "海龟20/10（日线简化）",
    family: "突破",
    rule: "突破此前20日高点买；跌破此前10日低点或成交价下2×ATR20卖。不加仓、不做空、不作日内止损。",
  },
  "boll-breakout": {
    name: "布林趋势突破",
    family: "突破",
    rule: "C>BOLL(20,2)上轨买；C<中轨卖。",
  },
  keltner: {
    name: "肯特纳通道20×2",
    family: "突破",
    rule: "C>EMA20+2×ATR20买；C<EMA20卖，ATR为算术均值。",
  },
  "dual-thrust": {
    name: "Dual Thrust（日线确认）",
    family: "突破",
    rule: "R=max(HH4-LC4,HC4-LL4)，窗口排除本日；C>本日O+0.5R买，C<本日O-0.5R卖。不是原日内双向系统。",
  },
  momentum120: {
    name: "半年时序动量",
    family: "动量",
    rule: "C/C[t-120]-1>0买，<0卖；现金为零收益对照。",
  },
  momentum250: {
    name: "一年时序动量",
    family: "动量",
    rule: "C/C[t-250]-1>0买，<0卖；250日近似一年。",
  },
  "skip-momentum": {
    name: "12减1月动量择时",
    family: "动量",
    rule: "C[t-20]/C[t-250]-1>0买，<0卖；单股时序改编，不是横截面多空组合。",
  },
  "rsi-trend": {
    name: "RSI14动量",
    family: "动量",
    rule: "RSI14>55买，<45卖。",
  },
  "rsi-reversion": {
    name: "RSI14超卖反转",
    family: "反转",
    rule: "RSI14<30买；>70、持20日或亏8%卖。",
  },
  rsi2: {
    name: "RSI2趋势低吸",
    family: "回调",
    rule: "C>MA200且RSI2<10买；C>MA5、C<MA200或持10日卖。仅借鉴短RSI低吸范式。",
  },
  kdj: {
    name: "KDJ低位金叉",
    family: "反转",
    rule: "K上穿D且K<30买；K下穿D且K>70、持20日或亏8%卖。",
  },
  cci: {
    name: "CCI20反转",
    family: "反转",
    rule: "CCI20<-100买；CCI20>100、持20日或亏8%卖。CCI使用典型价与平均绝对偏差。",
  },
  williams: {
    name: "Williams %R14",
    family: "反转",
    rule: "%R14<-80买；>-20、持20日或亏8%卖。",
  },
  "short-reversal": {
    name: "五日短期反转",
    family: "反转",
    rule: "五日跌幅超过5%买；C>MA5、持10日或亏8%卖。",
  },
  bias: {
    name: "BIAS20乖离回归",
    family: "反转",
    rule: "C/MA20-1<-8%买；回MA20、持20日或亏8%卖。",
  },
  mfi: {
    name: "MFI14资金流反转",
    family: "量价",
    rule: "MFI14<20买；>80、持20日或亏8%卖。典型价×原始成交量，不是机构资金流。",
  },
  obv: {
    name: "OBV量价趋势",
    family: "量价",
    rule: "OBV>其MA20且C>MA60买；OBV<其MA20或C<MA60卖。",
  },
  "volume-breakout": {
    name: "放量20日突破",
    family: "量价",
    rule: "突破此前20日高点且成交量>此前20日均量1.5倍买；跌破MA20卖。",
  },
  cmf: {
    name: "Chaikin资金流20",
    family: "量价",
    rule: "CMF20>0.1且C>MA60买；CMF20<0或C<MA60卖。零振幅日乘数为0。",
  },
  chandelier: {
    name: "吊灯ATR跟踪退出",
    family: "趋势",
    rule: "C>MA50买；C<入场以来最高收盘-3×ATR22卖，收盘确认次日执行。",
  },
  "vol-target": {
    name: "15%目标波动仓位",
    family: "仓位",
    rule: "首日及每周五收盘将股票权重调至min(1,0.15/(20日收益样本波动率×sqrt(252)))；波动为0时权重1，不借款。",
  },
  "constant-mix": {
    name: "80/20恒定比例",
    family: "仓位",
    rule: "首日及每个自然月首次观察日收盘，以股票80%/现金20%再平衡。",
  },
  cppi: {
    name: "CPPI动态仓位",
    family: "仓位",
    rule: "每日目标股票金额=min(可投资资产,3×max(可投资资产-初始本金80%,0))；固定底线，现金零利息，不保证保本。",
  },
  dca: {
    name: "12个月分批建仓",
    family: "仓位",
    rule: "初始100万元已全部在账户，每月用初始本金1/12建仓一次，最多12批；失败重试；无外部入金、不复投分红。",
  },
  seasonal: {
    name: "十一月至四月季节性",
    family: "日历",
    rule: "11月至次年4月持有，5月至10月现金；当日收盘识别月份后次日开盘调整。",
  },
  "calendar-turn-of-month": {
    name: "月末月初日历效应",
    family: "事件",
    rule: "每月最后三个自然日若有交易，收盘发出入场信号。跨月后或月初十日内，当月第三根已完成日线起发出退出信号；最迟在距入场满十根日线时退出。",
  },
};
export const studyNames = Object.fromEntries(
  studyStrategies.map((id) => [id, studyCatalog[id].name]),
) as Record<StudyStrategy, string>;
export const studyWarmup = (strategy: StudyStrategy) => {
  if (strategy === "calendar-turn-of-month") return 0;
  return strategy === "theory-stage150"
    ? 170
    : strategy.startsWith("theory-")
      ? 140
      : strategy === "research-growth"
        ? 300
        : strategy.startsWith("research-") ||
            strategy === wyckoffTrendVol10Diagnostic ||
            (classicStudyStrategies as readonly string[]).includes(strategy)
          ? 140
          : Math.max(
              140,
              classicDefinitions.find((d) => d.id === strategy)?.warmupBars ??
                300,
            );
};

/** Families that require different instruments or evidence are visible gaps. */
export const studyCoverageGaps = [
  {
    family: "横截面动量、价值、质量、成长、低波、多因子与行业轮动",
    needs:
      "历史全证券池、退市样本、披露时点财报/估值、历史行业归属及多证券组合撮合；单只茅台无法验证选股。",
  },
  {
    family: "配对交易、统计套利、市场中性、协整与因子对冲",
    needs: "至少两个可交易标的、借券可得性/成本、双腿及共享资金约束。",
  },
  {
    family: "期现/跨期/跨市场套利、carry、展期与期货CTA组合",
    needs:
      "期货/现货合约、展期、保证金、基差及多市场日历；本次时序趋势只覆盖CTA的趋势思想。",
  },
  {
    family: "期权波动率、波动率风险溢价、波动套利与可转债套利",
    needs: "历史期权链/转债、隐含波动率、Greeks、行权交割与多腿成本。",
  },
  {
    family: "高频做市、订单流、日内VWAP/TWAP与开盘区间突破",
    needs:
      "可靠逐笔/盘口或分钟数据、队列和延迟；日线不虚构日内成交。VWAP/TWAP主要是执行算法。",
  },
  {
    family: "财报/公告/新闻事件、并购套利与另类数据",
    needs: "可核验首次发布时间、历史修订版本、事件覆盖和适合证券池。",
  },
  {
    family: "风险平价、均值方差、Black-Litterman与跨资产配置",
    needs:
      "多资产可投资历史、协方差和现金/融资约束；单资产目标波动不冒称风险平价。",
  },
  {
    family: "机器学习、深度学习、强化学习与组合集成",
    needs:
      "按时间划分训练/验证/测试、足够样本及防泄漏特征；不能用茅台十年原样训练后报告同段业绩。",
  },
  {
    family: "缠论、威科夫、CANSLIM与SEPA",
    needs:
      "项目既有方法已保留但执行入口弃用；重新接入须逐项确认结构确认时点/全市场及基本面证据，不以单一指标冒充完整方法。",
  },
] as const;

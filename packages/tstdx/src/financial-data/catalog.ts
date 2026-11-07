import { financialSourceRows } from "./catalog-source.js";

export const financialMappingVersion = "tdx-financial-20261107-v1";
export type FinancialNamespace = "FN" | "GP" | "BK" | "SC" | "GO";
export type FinancialUnit =
  | "元"
  | "股"
  | "户"
  | "家"
  | "人"
  | "手"
  | "份"
  | "%"
  | "比例"
  | "元/股"
  | "日期"
  | "时间"
  | "枚举"
  | "原单位"
  | "天"
  | "分";
export type FinancialDefinition = {
  code: string;
  namespace: FinancialNamespace;
  id: number;
  label: string;
  section: string;
  slot: number | null;
  unit: FinancialUnit;
  rawUnit: string;
  scale: number;
  timing:
    | "balance"
    | "cumulative"
    | "single-quarter"
    | "ttm"
    | "forecast"
    | "flash"
    | "event"
    | "statistics"
    | "unknown";
  financialOnly: boolean;
  nonFinancialOnly: boolean;
  mappingStatus: "mapped" | "unverified" | "no-local-carrier";
};

const percentIds = new Set([
  6, 183, 184, 185, 186, 187, 188, 189, 190, 191, 193, 194, 195, 196, 197, 198,
  199, 200, 201, 202, 203, 204, 205, 209, 210, 211, 212, 213, 214, 215, 216,
  217, 218, 220, 221, 222, 281, 285, 286, 292, 293, 327, 329, 337, 342, 343,
  346, 347, 350, 351, 354, 355,
]);
const forecastIds = new Set([
  285, 286, 313, 317, 318, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349,
  350, 351, 352, 353, 354, 355, 356, 357,
]);
const flashIds = new Set([
  287, 288, 289, 290, 291, 292, 293, 294, 315, 330, 331, 332, 333, 334, 335,
]);
const dateIds = new Set([313, 314, 315]);
const countIds = new Map<number, FinancialUnit>([
  [242, "户"],
  [246, "家"],
  [248, "家"],
  [250, "家"],
  [252, "家"],
  [254, "家"],
  [256, "家"],
  [258, "家"],
  [260, "家"],
  [262, "家"],
  [272, "家"],
  [274, "家"],
  [277, "家"],
  [279, "家"],
  [320, "人"],
  [325, "家"],
  [360, "家"],
  [363, "人"],
]);
const shareIds = new Set([
  238, 239, 240, 241, 243, 244, 245, 247, 249, 251, 253, 255, 257, 259, 261,
  263, 264, 265, 266, 267, 273, 275, 278, 280, 284, 326, 361,
]);

function fnUnit(
  id: number,
  label: string,
  section: string,
): { unit: FinancialUnit; rawUnit: string; scale: number } {
  if (dateIds.has(id)) return { unit: "日期", rawUnit: "YYMMDD", scale: 1 };
  if (id === 336) return { unit: "枚举", rawUnit: "审计意见代码", scale: 1 };
  if ([177, 178, 180, 181].includes(id))
    return { unit: "天", rawUnit: "天", scale: 1 };
  if (
    [
      159, 160, 162, 172, 173, 174, 175, 176, 179, 182, 223, 224, 226, 227, 228,
      229,
    ].includes(id)
  )
    return { unit: "比例", rawUnit: "比例/倍数（非百分数）", scale: 1 };
  if (id === 362) return { unit: "分", rawUnit: "供应商评分", scale: 1 };
  if (percentIds.has(id) || /[%％]/.test(label))
    return { unit: "%", rawUnit: "%", scale: 1 };
  const count = countIds.get(id);
  if (count) return { unit: count, rawUnit: count, scale: 1 };
  if (shareIds.has(id) || /\(股\)|（股）/.test(label))
    return {
      unit: "股",
      rawUnit: label.includes("万股") ? "万股" : "股",
      scale: label.includes("万股") ? 10000 : 1,
    };
  if (label.includes("每股") || id === 501)
    return { unit: "元/股", rawUnit: "元/股", scale: 1 };
  if (/万元/.test(label)) return { unit: "元", rawUnit: "万元", scale: 10000 };
  if (
    /元/.test(label) ||
    /资产负债表|利润表|现金流量表|单季度财务指标/.test(section) ||
    [
      206, 207, 208, 268, 269, 270, 271, 276, 287, 288, 289, 290, 295, 296, 297,
      298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 321, 322, 330, 331, 332,
      333, 334, 335,
    ].includes(id)
  )
    return { unit: "元", rawUnit: "元", scale: 1 };
  // Undocumented dimensions remain explicit; no guessed percent or yuan conversion.
  return { unit: "原单位", rawUnit: "官方未明确标注", scale: 1 };
}
function fnTiming(id: number, section: string): FinancialDefinition["timing"] {
  if (forecastIds.has(id)) return "forecast";
  if (flashIds.has(id)) return "flash";
  if (
    /TTM|近一年/.test(
      financialSourceRows.find((row) => row.code === `FN${id}`)?.label ?? "",
    )
  )
    return "ttm";
  if (/单季度/.test(section) || [282, 311, 312, 324, 328].includes(id))
    return "single-quarter";
  if (
    /资产负债|股本股东|机构持股/.test(section) ||
    [271, 320, 336, 360, 361, 363].includes(id)
  )
    return "balance";
  if (/财务诊断/.test(section)) return "unknown";
  return "cumulative";
}
export const financialCatalog: FinancialDefinition[] = financialSourceRows.map(
  (row) => {
    const namespace = row.code.match(/^[A-Z]+/)![0] as FinancialNamespace;
    const id = Number(row.code.slice(namespace.length));
    const fn = namespace === "FN";
    return {
      ...row,
      namespace,
      id,
      // Diagnostic FN565x -> physical 65x is a candidate, not certified metadata.
      slot: fn && id <= 658 ? id - 1 : null,
      ...(fn
        ? fnUnit(id, row.label, row.section)
        : { unit: "原单位" as const, rawUnit: "见组内值定义", scale: 1 }),
      timing: fn
        ? fnTiming(id, row.section)
        : namespace === "GO"
          ? "unknown"
          : "event",
      financialOnly:
        /金融类科目|金融类指标/.test(row.label) && !/非金融/.test(row.label),
      nonFinancialOnly: /非金融/.test(row.label),
      mappingStatus:
        namespace === "GO"
          ? "no-local-carrier"
          : fn && (id > 658 || id === 192)
            ? "unverified"
            : "mapped",
    };
  },
);
const definitions = new Map(
  financialCatalog.map((field) => [field.code, field]),
);
export const financialField = (code: string) => definitions.get(code);

// Each side has its own label and unit; SC/GP/BK numbers are separate namespaces.
const pairs: Record<string, string[]> = {
  GP1: ["股东户数(户)"],
  GP2: ["买入总计(万元)", "卖出总计(万元)"],
  GP3: ["融资余额(万元)", "融券余量(股)"],
  GP4: ["成交均价(元)", "成交额(万元)"],
  GP5: ["成交均价(元)", "变动股数(股)"],
  GP6: ["陆股通持股数量(股)"],
  GP7: ["陆股通净买入(万元)"],
  GP8: ["卖方机构个数(家)", "机构卖出金额(万元)"],
  GP9: ["买方机构个数(家)", "机构买入金额(万元)"],
  GP10: ["近三月调研次数", "近三月调研机构数量(家)"],
  GP11: ["融资买入额(万元)", "融资偿还额(万元)"],
  GP12: ["融券卖出量(股)", "融券偿还量(股)"],
  GP13: ["融资净买入(万元)", "融券净卖出(股)"],
  GP14: ["涨停金额(万元)", "开板次数"],
  GP15: ["涨跌停状态", "封单金额(万元)"],
  GP16: ["总市值(万元)"],
  GP17: ["营业部买入金额(万元)", "营业部卖出金额(万元)"],
  GP18: ["沪深股通买入金额(万元)", "沪深股通卖出金额(万元)"],
  GP19: ["无限售质押股数(万股)", "有限售质押股数(万股)"],
  GP20: ["质押比例(%)"],
  GP21: ["股息率(%)"],
  GP22: ["封成比", "封流比"],
  GP23: ["拟增持(万股)", "拟减持(万股)"],
  GP24: ["首次涨停时间", "最大封单额(万元)"],
  GP25: ["开盘成交量(手)", "盘后固定成交量(手)"],
  GP26: ["拟增持金额(万元)", "拟减持金额(万元)"],
  GP27: ["市场人气排名", "行业人气排名"],
  GP28: ["回购均价(元)", "回购数量(万股)"],
  GP29: ["停牌后复牌间隔(交易日)", "更名类别"],
  GP30: ["派息金额(万元)", "送转数量(股)"],
  GP31: ["转融券期初余量(股)", "转融券期末余量(股)"],
  GP32: ["转融券融出数量(股)", "转融券融出市值(元)"],
  GP33: ["跌停金额(万元，官方暂无)", "开板次数"],
  GP34: ["首次跌停时间", "最大封单额(万元)"],
  GP35: ["增持数量(股)", "减持数量(股)"],
  GP36: ["竞价涨停买入金额(万元)"],
  GP37: ["上榜连续交易日(天)"],
  GP38: ["近一年涨停次数", "近一年溢价5%次数"],
  GP39: ["近一年首板封板率(%)", "近一年次日红盘率(%)"],
  GP40: ["近一年连板率(%)", "最后涨停时间"],
  GP41: ["配股股权登记日"],
  GP42: ["买方成交净额(万元)", "卖方成交净额(万元)"],
  GP43: ["配股价格(元)", "配股数量(万股)"],
  GP44: ["供应商综合评分"],
  GP45: ["评级系数"],
  GP46: ["拟转让股数(万股)", "拟转让占总股本(%)"],
  GP47: ["ETF申购净流入(万元)"],
  GP48: ["资金得分"],
  GP49: ["A股股权登记日", "A股除权除息日"],
  GP50: ["开盘成交额(万元)", "盘后固定成交额(万元)"],
  GP51: ["基金单位净值", "基金累计净值"],
  GP52: ["基金份额(万份)", "基金规模(万元)"],
  BK5: ["PE TTM整体法", "PE TTM算术平均"],
  BK6: ["PB MRQ整体法", "PB MRQ算术平均"],
  BK7: ["PS TTM整体法", "PS TTM算术平均"],
  BK8: ["PCF TTM整体法", "PCF TTM算术平均"],
  BK9: ["上涨家数", "下跌家数"],
  BK10: ["总市值整体法(亿元)", "总市值算术平均(亿元)"],
  BK11: ["流通市值整体法(亿元)", "流通市值算术平均(亿元)"],
  BK12: ["涨停家数", "曾涨停家数"],
  BK13: ["跌停家数", "曾跌停家数"],
  BK14: ["市场高度", "两板及以上家数"],
  BK15: ["融资余额(万元)", "融券余额(万元)"],
  BK16: ["沪股通流入(亿元)", "深股通流入(亿元)"],
  BK17: ["开盘成交额(万元)", "开盘成交量(万股)"],
  BK18: ["股息率算术平均(%)", "股息率整体法(%)"],
  BK19: ["自由流通市值整体法(亿元)", "自由流通市值算术平均(亿元)"],
};
const scPairs = [
  ["融资余额(万元)", "融券余额(万元)"],
  ["沪股通流入(亿元)", "深股通流入(亿元)"],
  ["涨停家数", "曾涨停家数"],
  ["跌停家数", "曾跌停家数"],
  ["上证50期货净持仓(手)"],
  ["沪深300期货净持仓(手)"],
  ["中证500期货净持仓(手)"],
  ["ETF份额(亿份)", "ETF净申赎(亿份)"],
  ["新开A股账户(万户)"],
  ["增持额(万元)", "减持额(万元)"],
  ["溢价大宗额(万元)", "折价大宗额(万元)"],
  ["限售解禁计划额(亿元)", "实际上市金额(亿元)"],
  ["市场分红额(亿元)"],
  ["市场募资额(亿元)"],
  ["封板成功资金(亿元)", "封板失败资金(亿元)"],
  ["龙虎榜买入额(亿元)", "龙虎榜卖出额(亿元)"],
  ["机构买入额(亿元)", "机构卖出额(亿元)"],
  ["营业部买入额(亿元)", "营业部卖出额(亿元)"],
  ["沪深股通买入额(亿元)", "沪深股通卖出额(亿元)"],
  ["沪股通净买入(亿元)", "深股通净买入(亿元)"],
  ["深市无限售质押率(%)", "沪市无限售质押率(%)"],
  ["深市有限售质押率(%)", "沪市有限售质押率(%)"],
  ["连板股含ST家数", "连板股不含ST家数"],
  ["涨停家数不含ST", "跌停家数不含ST"],
  ["融资买入额(万元)", "融券卖出量(万股)"],
  ["市场质押率(%)"],
  ["央行公开市场净投放(亿元)"],
  ["历史新高家数", "历史新低家数"],
  ["120天新高家数", "120天新低家数"],
  ["市场高度", "两板以上家数"],
  ["上涨家数", "下跌家数"],
  ["20天新高家数", "20天新低家数"],
  ["涨停封单额(亿元)", "跌停封单额(亿元)"],
  ["上涨股成交量(万手)", "下跌股成交量(万手)"],
  ["换手板家数", "回封率(%)"],
  ["曾涨停家数", "曾跌停家数"],
  ["转融券融出市值(亿元)", "转融券期末余额(亿元)"],
  ["ETF规模(亿元)", "ETF净申赎(亿元)"],
  ["涨幅≥5%家数", "跌幅≥5%家数"],
  ["陆股通成交额(亿元)", "陆股通成交笔数(万笔)"],
  ["中证1000期货净持仓(手)"],
  ["沪股通成交额(亿元)", "深股通成交额(亿元)"],
];
scPairs.forEach((pair, i) => {
  pairs[`SC${i + 1}`] = pair;
});
export function seriesValueDefinition(
  namespace: "GP" | "BK" | "SC",
  id: number,
  side: 0 | 1,
) {
  const label = pairs[`${namespace}${id}`]?.[side];
  if (!label) return null;
  let scale = 1,
    unit: FinancialUnit = "原单位",
    rawUnit = "原单位";
  const match = label.match(/[（(]([^()（）]+)[)）]/);
  if (match) {
    rawUnit = match[1]!;
    if (rawUnit.startsWith("亿")) scale = 1e8;
    else if (rawUnit.startsWith("万")) scale = 1e4;
    const base = rawUnit.replace(/^[万亿]/, "");
    if (["元", "股", "户", "家", "人", "手", "份", "%"].includes(base))
      unit = base as FinancialUnit;
  }
  if (/日期|登记日|除权除息日/.test(label)) unit = "日期";
  if (/时间/.test(label)) unit = "时间";
  return { label, scale, unit, rawUnit };
}

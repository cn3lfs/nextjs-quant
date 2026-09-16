import type { Bar } from "./domain";
import { evaluateFormula } from "./tdx-formula";

// Exact source blocks are retained separately from the executable engineering adapters.
export const externalFormulaOriginals: Record<string, string> = {
  "SW12-buffett":
    "A1:=(FINANCE(20)-FINANCE(21) )/FINANCE(20)*100>N1;{销售毛利率}\n    A2:=FINANCE(30)/FINANCE(20)*100>N2;{净利率}\n    A3:=FINANCE(30)/FINANCE(19)*100>N3;{净资产收益率}\n    A1 AND A2 AND A3;",
  "SW12-old-duck":
    "E1:=EMA(C,13);\n    E2:=EMA(C,55);\n    A1:=COUNT(E1<REF(E1,1),5)>=3 AND E1>REF(E1,1);\n    A2:=COUNT(E2>REF(E2,1),13)>=8 AND E2>REF(E2,1);\n    A3:=LLV((L/E2-1),13)<=0.1;\n    A4:=COUNT(E1>E2,13)=13;\n    A5:=COUNT(C>E2,5)=5;\n    A6:=CROSS(C,E1);\n    A7:=V>MA(V,5);\n    YT:=A1 AND A2 AND A3 AND A4 AND A5 AND A6 AND A7;\n    LYT:=FILTER(YT,10);\n    FXG:=FINANCE(42)>100;\n    NTP:=DYNAINFO(8)>0;\n    LYT AND FXG AND NTP;",
  "SW12-limit-state":
    "ISST股:=NAMEINCLUDE('ST');\n    涨停10:=NOT(ISST股) AND DYNAINFO(5)=ZTPRICE(DYNAINFO(3),IF((FINANCE(3)=4 OR FINANCE(3)=3),0.2,0.1)) AND DYNAINFO(5)>0;\n    涨停5:=ISST股 AND DYNAINFO(5)=ZTPRICE(DYNAINFO(3),0.05) AND DYNAINFO(5)>0;\n    所有涨停:=(涨停10 OR 涨停5) AND (包括一字板 OR (NOT(包括一字板) AND DYNAINFO(5)!=DYNAINFO(6)));\n    当前涨停:=所有涨停 AND MAX(DYNAINFO(20),DYNAINFO(7))=DYNAINFO(5) AND DYNAINFO(59)<1;\n    仅盘中涨停:=所有涨停 AND NOT(当前涨停);\n    跌停10:=NOT(ISST股) AND DYNAINFO(6)=DTPRICE(DYNAINFO(3),IF((FINANCE(3)=4 OR FINANCE(3)=3),0.2,0.1)) AND DYNAINFO(6)>0;\n    跌停5:=ISST股 AND DYNAINFO(6)=DTPRICE(DYNAINFO(3),0.05) AND DYNAINFO(6)>0;\n    所有跌停:=(跌停10 OR 跌停5) AND (包括一字板 OR (NOT(包括一字板) AND DYNAINFO(5)!=DYNAINFO(6)));\n    当前跌停:=所有跌停 AND MIN(DYNAINFO(21),DYNAINFO(7))=DYNAINFO(6) AND DYNAINFO(58)<1;\n    仅盘中跌停:=所有跌停 AND NOT(当前跌停);\n    涨停RET:=IF(涨跌停类型=0,所有涨停,IF(涨跌停类型=1,当前涨停,仅盘中涨停));\n    跌停RET:=IF(涨跌停类型=3,所有跌停,IF(涨跌停类型=4,当前跌停,仅盘中跌停));\n    IF(涨跌停类型<3,涨停RET,跌停RET);",
  "SW12-psy-rank": "排名:=INSORT('深沪A股','PSY',2,0);PSYMA:排名>=10;",
  "SW12-four-limit-down":
    "DT:=(C-REF(C,1) ) /REF(C,1) *100<=-9;\nTJ:=EVERY(DT,4) ;\nSHUCHU:IF(( YEAR>2007 OR (YEAR=2007 AND ( MONTH>6 OR (MONTH=6 AND DAY>=1)  )  )  ) ,TJ,0) ;\n\n\nDT:=(C-REF(C,1) ) /REF(C,1) *100<=-9;\nTJ:EVERY(DT,4) ;{注意需要在条件选股中设定选股的日期范围}\n",
  "SW12-ten-limit": "EXIST(C>=REF(C,1)*1.097,10);",
  "SW12-relative-strength": "C/REF(C,20)>INDEXC/REF(INDEXC,20);",
};
const oldDuckCore =
  "E1:=EMA(C,13);E2:=EMA(C,55);A1:=COUNT(E1<REF(E1,1),5)>=3 AND E1>REF(E1,1);A2:=COUNT(E2>REF(E2,1),13)>=8 AND E2>REF(E2,1);A3:=LLV((L/E2-1),13)<=0.1;A4:=COUNT(E1>E2,13)=13;A5:=COUNT(C>E2,5)=5;A6:=CROSS(C,E1);A7:=V>MA(V,5);YT:=A1 AND A2 AND A3 AND A4 AND A5 AND A6 AND A7;FILTER(YT,10);";
export const externalFormulaProfiles = {
  "tdx-finance-asof": ["SW12-buffett", "财务三阈值 · 披露时点修订", "finance"],
  "tdx-duck-asof": ["SW12-old-duck", "老鸭头 · 历史上市天数修订", "duck"],
  "tdx-limit-up-any": ["SW12-limit-state", "曾触涨停 · 历史限价修订", "up-any"],
  "tdx-limit-up-current": [
    "SW12-limit-state",
    "收盘仍封涨停 · 盘口修订",
    "up-current",
  ],
  "tdx-limit-up-intraday": [
    "SW12-limit-state",
    "仅盘中触涨停 · 盘口修订",
    "up-intraday",
  ],
  "tdx-limit-down-any": [
    "SW12-limit-state",
    "曾触跌停退出 · 历史限价修订",
    "down-any",
  ],
  "tdx-limit-down-current": [
    "SW12-limit-state",
    "收盘仍封跌停退出 · 盘口修订",
    "down-current",
  ],
  "tdx-limit-down-intraday": [
    "SW12-limit-state",
    "仅盘中触跌停退出 · 盘口修订",
    "down-intraday",
  ],
  "tdx-psy-rank-asof": [
    "SW12-psy-rank",
    "PSY第二输出降序名次≥10 · 历史证券池修订",
    "rank",
  ],
  "tdx-four-down-asof": [
    "SW12-four-limit-down",
    "四日真实跌停退出 · 历史限价修订",
    "four",
  ],
  "tdx-ten-up-asof": ["SW12-ten-limit", "十日内真实涨停 · 历史限价修订", "ten"],
  "tdx-relative-asof": [
    "SW12-relative-strength",
    "20日相对指数 · 同日序列修订",
    "relative",
  ],
} as const;
export type ExternalFormulaId = keyof typeof externalFormulaProfiles;
export const externalFormulaIds = Object.keys(
  externalFormulaProfiles,
) as ExternalFormulaId[];
export function isExternalFormula(id: string): id is ExternalFormulaId {
  return Object.hasOwn(externalFormulaProfiles, id);
}
export const externalFormulaBoundary =
  "待数据工程修订v1：原FINANCE/DYNAINFO/INSORT/INDEXC不可由现有核执行；1.097和-9%虽可解析但不能等价跨板块真实涨跌停，原例不可用于交易运行。财务固定毛利率>20%、净利率>10%、ROE>15%，同币种同期间营业收入/营业成本/净利润/净资产及首次可得日，净资产和营收必须正；老鸭头保留原EMA与FILTER，在收盘完成时用上市自然天数>100且已完成日量>0替换当前财务及即时总量。涨跌停使用当日有证据的限价，不推断比例；六种状态默认包含一字板，盘口缺失不从日线猜测封板。四跌停仅date>=2007-06-01输出；十日涨停需完整10根证据。PSY第二输出工程固定PSY12的MA6，用同日历史池完整18根收盘，降序竞赛排名并列同名次，保留排名≥10（不是前10名）。相对强度按证券20根前对应日指数比较，缺日不移位补齐。所有输入逐观察日source/date/availableDate可审计，修订非等价原式；缺失不补零。收盘首次已知false转true入场，MA5/10死叉退出；跌停项以MA金叉为基线、规则true退出。下一可成交开盘、T+1、最长持有期保留，全部输入公司行动覆盖。";
export function externalFormulaDefinition(id: ExternalFormulaId) {
  const [method, title] = externalFormulaProfiles[id];
  return {
    label: title,
    family: "通达信待数据示例",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: [
      method === "SW12-buffett" || method === "SW12-old-duck"
        ? "tdx-doc/references/examples/条件选股公式.md"
        : method === "SW12-limit-state"
          ? "tdx-doc/references/examples/条件选股公式.md"
          : method === "SW12-psy-rank" || method === "SW12-four-limit-down"
            ? "tdx-doc/references/tutorials/答疑.md"
            : "tdx-doc/SKILL.md",
    ],
    description: `${externalFormulaBoundary} 原式（不可运行）：${externalFormulaOriginals[method]}`,
  };
}
export type ExternalFormulaEvidence = {
  date: string;
  availableDate: string;
  source: string;
  finance?: {
    revenue: number;
    cost: number;
    profit: number;
    equity: number;
    period: string;
    currency: string;
  };
  listedDate?: string;
  limits?: {
    hasDailyLimit: boolean;
    up: number | null;
    down: number | null;
    includeOnePrice?: boolean;
  };
  book?: { bid: number; ask: number; bidVolume: number; askVolume: number };
  benchmarkClose?: number;
  universe?: {
    symbol: string;
    complete: boolean;
    dates: readonly string[];
    members: readonly { symbol: string; closes: readonly number[] }[];
  };
};
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const dateValid = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const known = (e: ExternalFormulaEvidence | undefined, date: string) =>
  !!e &&
  dateValid(e.date) &&
  dateValid(e.availableDate) &&
  e.date === date &&
  e.availableDate <= date &&
  !!e.source.trim();
export function formulaPsyRank(
  universe: NonNullable<ExternalFormulaEvidence["universe"]>,
  dates: readonly string[],
): number | null {
  if (
    !universe.complete ||
    dates.length !== 18 ||
    universe.dates.length !== 18 ||
    !dates.every((d, i) => universe.dates[i] === d) ||
    new Set(universe.members.map((m) => m.symbol)).size !==
      universe.members.length ||
    !universe.members.some((m) => m.symbol === universe.symbol)
  )
    return null;
  const scores = universe.members.map((m) => {
    if (m.closes.length !== 18 || !m.closes.every(positive)) return null;
    let sum = 0;
    for (let end = 12; end < 18; end++) {
      let up = 0;
      for (let j = end - 11; j <= end; j++)
        if (m.closes[j]! > m.closes[j - 1]!) up++;
      sum += (up / 12) * 100;
    }
    return { symbol: m.symbol, score: sum / 6 };
  });
  if (scores.some((s) => s === null)) return null;
  const target = scores.find((s) => s!.symbol === universe.symbol)!.score;
  return 1 + scores.filter((s) => s!.score > target).length;
}
export function externalFormulaDecision(
  id: ExternalFormulaId,
  bars: readonly Bar[],
  index: number,
  evidence: readonly ExternalFormulaEvidence[],
  duck: number | null = null,
): { value: number | null; reason: string | null } {
  const profile = externalFormulaProfiles[id][2],
    bar = bars[index]!;
  const at = (i: number) => {
    const rows = evidence.filter((e) => e.date === bars[i]?.date);
    return rows.length === 1 && known(rows[0], bars[i]!.date)
      ? rows[0]
      : undefined;
  };
  const missing = (reason: string) => ({
    value: null,
    reason: `待数据：${reason}`,
  });
  const row = at(index);
  if (!row)
    return missing(
      `观察日唯一date/availableDate/source证据；${
        profile === "finance"
          ? "披露时点、同期间同币种营收/成本/净利润/净资产"
          : profile === "duck"
            ? "历史上市日期"
            : profile === "rank"
              ? "历史证券池完整成员及18根同日收盘"
              : profile === "relative"
                ? "指数当日与20根前同日收盘"
                : "逐日历史限价及六类状态所需买卖一价量"
      }`,
    );
  let result: boolean;
  if (profile === "finance") {
    const f = row.finance;
    if (
      !f ||
      !positive(f.revenue) ||
      !positive(f.equity) ||
      !Number.isFinite(f.cost) ||
      !Number.isFinite(f.profit) ||
      !dateValid(f.period) ||
      f.period > row.availableDate ||
      !f.currency.trim()
    )
      return missing("同期间同币种财务及可得日");
    result =
      ((f.revenue - f.cost) / f.revenue) * 100 > 20 &&
      (f.profit / f.revenue) * 100 > 10 &&
      (f.profit / f.equity) * 100 > 15;
  } else if (profile === "duck") {
    if (
      !row.listedDate ||
      !dateValid(row.listedDate) ||
      row.listedDate > bar.date ||
      duck === null
    )
      return missing("上市日或老鸭头价量窗口");
    result =
      duck !== 0 &&
      (Date.parse(bar.date) - Date.parse(row.listedDate)) / 86400000 > 100 &&
      bar.volume > 0;
  } else if (profile === "relative") {
    if (index < 20) return missing("20根前证券及指数");
    const old = at(index - 20);
    if (
      !old ||
      !positive(old.benchmarkClose) ||
      !positive(row.benchmarkClose) ||
      !positive(bars[index - 20]!.close)
    )
      return missing("指数同日收盘及20根前同日收盘");
    result =
      bar.close / bars[index - 20]!.close >
      row.benchmarkClose / old.benchmarkClose;
  } else if (profile === "rank") {
    const rank = row.universe
      ? formulaPsyRank(
          row.universe,
          bars.slice(Math.max(0, index - 17), index + 1).map((b) => b.date),
        )
      : null;
    if (rank === null) return missing("历史证券池完整18根及PSY第二输出");
    result = rank >= 10;
  } else {
    const limits = (i: number) => {
      const r = at(i),
        v = r?.limits;
      return v &&
        ((!v.hasDailyLimit && v.up === null && v.down === null) ||
          (v.hasDailyLimit &&
            positive(v.up) &&
            positive(v.down) &&
            v.up > v.down))
        ? v
        : undefined;
    };
    if (profile === "ten" || profile === "four") {
      const n = profile === "ten" ? 10 : 4;
      if (index < n - 1) return missing(`${n}根历史限价`);
      const hits: boolean[] = [];
      for (let j = index - n + 1; j <= index; j++) {
        const l = limits(j);
        if (!l || !positive(bars[j]!.close) || !positive(bars[j]!.volume))
          return missing(`${bars[j]!.date}历史限价或成交日线`);
        hits.push(
          l.hasDailyLimit &&
            (profile === "ten"
              ? bars[j]!.close === l.up
              : bars[j]!.close === l.down),
        );
      }
      result =
        profile === "ten"
          ? hits.some(Boolean)
          : bar.date >= "2007-06-01" && hits.every(Boolean);
    } else {
      const l = limits(index);
      if (!l) return missing("当日历史限价");
      const down = profile.startsWith("down"),
        any =
          l.hasDailyLimit &&
          (down ? bar.low === l.down : bar.high === l.up) &&
          (l.includeOnePrice !== false || bar.high !== bar.low);
      if (profile.endsWith("any")) result = any;
      else {
        const b = row.book;
        if (
          !b ||
          ![b.bid, b.ask, b.bidVolume, b.askVolume].every(
            (v) => Number.isFinite(v) && v >= 0,
          )
        )
          return missing("收盘买卖一价量快照");
        const current =
          any &&
          (down
            ? Math.min(b.ask, bar.close) === bar.low && b.bidVolume < 1
            : Math.max(b.bid, bar.close) === bar.high && b.askVolume < 1);
        result = profile.endsWith("current") ? current : any && !current;
      }
    }
  }
  return { value: +result, reason: null };
}
export function researchExternalFormulaSeries(
  id: ExternalFormulaId,
  bars: readonly Bar[],
  evidence: readonly ExternalFormulaEvidence[] = [],
) {
  const valid = (b: Bar) =>
    positive(b.volume) &&
    [b.open, b.close, b.high, b.low].every(positive) &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close);
  const input = bars.map((b) =>
    valid(b)
      ? b
      : { ...b, open: NaN, close: NaN, high: NaN, low: NaN, volume: NaN },
  );
  const baseline = evaluateFormula(
    "ENTRY:CROSS(MA(C,5),MA(C,10));EXIT:CROSS(MA(C,10),MA(C,5));",
    input,
  ).outputs;
  const duck =
    id === "tdx-duck-asof"
      ? evaluateFormula(oldDuckCore, input).outputs[0]!.values
      : null;
  const bearish =
    externalFormulaProfiles[id][2].startsWith("down") ||
    id === "tdx-four-down-asof";
  let previous: number | null = null;
  return bars.map((bar, i) => {
    const decision = valid(bar)
      ? externalFormulaDecision(id, input, i, evidence, duck?.[i] ?? null)
      : { value: null, reason: "价量无效" };
    const exit =
      valid(bar) &&
      (bearish ? decision.value === 1 : baseline[1]!.values[i] === 1);
    const entry =
      !exit &&
      !decision.reason &&
      (bearish
        ? baseline[0]!.values[i] === 1
        : decision.value === 1 && previous === 0);
    previous = decision.value;
    const values: Record<string, number | null> = {
      close: positive(bar.close) ? bar.close : null,
      formula: decision.value,
    };
    return {
      date: bar.date,
      entry,
      exit,
      reason: decision.reason,
      values,
      formula: {
        id,
        original: {
          runnable: false,
          expression: externalFormulaOriginals[externalFormulaProfiles[id][0]],
        },
        revision: externalFormulaBoundary,
        availableEvidence: evidence.filter(
          (e) => e.date === bar.date && known(e, bar.date),
        ),
      },
    };
  });
}

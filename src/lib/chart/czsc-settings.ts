import { z } from "zod";

/** One row of czsc-tdx `czsc_config_options` (api v7). */
export type CzscConfigOption = {
  /** Decimal place: 1 stroke / 10 stroke end / 100 center unit / 1000 segment / 10000 segment boundary / 100000 center formation. */
  place: number;
  value: number;
  isDefault: number;
  /** 1 = lesson source; 0 = community / non-original rule. */
  original: number;
  key: string;
  label: string;
  lessons: string;
};

/**
 * Chart-only structure settings. Research, monitoring and the signal ledger stay
 * pinned to configs 0 / 1100 so backtests remain reproducible.
 */
export const czscSettingsSchema = z.object({
  stroke: z.number().int().min(0).max(9).default(0),
  strokeEnd: z.number().int().min(0).max(9).default(0),
  segment: z.number().int().min(0).max(9).default(1),
  /** Segment boundary display (api v8); feature-sequence segments only. */
  segmentEnd: z.number().int().min(0).max(9).default(0),
  /** Stroke-center formation (api v9): 0 by entering stroke / 1 obey parent segment. */
  centerMode: z.number().int().min(0).max(9).default(0),
});
export type CzscSettings = z.infer<typeof czscSettingsSchema>;
export const defaultCzscSettings: CzscSettings = czscSettingsSchema.parse({});

/**
 * DLL config codes for the two chart families. The stroke family keeps the
 * heuristic segment digit so defaults reproduce the pinned 0 / 1100 pair.
 */
export function czscCodes(s: CzscSettings): { 0: number; 1100: number } {
  const stroke = s.stroke + 10 * s.strokeEnd;
  // Parent-segment formation only changes stroke centers (segment centers keep
  // the entering rule), and must use the displayed segment algorithm as parent.
  const strokeFamily = s.centerMode
    ? stroke + 1000 * s.segment + 100000 * s.centerMode
    : stroke;
  // The boundary digit is only legal with feature-sequence segments.
  const boundary = s.segment === 1 ? 10000 * s.segmentEnd : 0;
  return {
    0: strokeFamily,
    1100: stroke + 100 + 1000 * s.segment + boundary,
  };
}

/**
 * Plain-language notes per DLL option key (czsc-tdx core/config.h and
 * chan-ambiguity-decisions.md). Names and provenance still come from the DLL;
 * an unknown key simply shows no note.
 */
export const czscOptionNotes: Record<string, string> = {
  // `center.segment` names both place 100 and 100000; the latter is suffixed.
  "center.entry":
    "中枢方向按进入笔命名，逐笔寻找最先重叠的三笔。上升线段里也可能出现“上下上”的中枢。",
  "center.segment@100000":
    "笔中枢服从所属线段：上升段只取“下上下”、下降段只取“上下上”，都取前三笔，三笔须在同一线段内。会改变笔中枢及其买卖点；线段中枢不受影响。社区口径，原文未作此规定。",
  "stroke.strict":
    "顶底分型之间至少隔一根独立K线（包含处理后顶底跨度≥4根）。最严格，笔最少、最稳定。",
  "stroke.new":
    "包含处理后跨度≥3，且原始K线跨度≥4，不要求独立K线。比老笔灵敏。",
  "stroke.czsc":
    "借鉴 waditu/czsc：包含处理后跨度≥3，且两端分型K线的高低区间互不包含。",
  "stroke.4k":
    "两端极值K线之间按原始K线计数，含两端≥4根；两分型不共用K线，不要求独立K线。",
  "stroke.fractal":
    "相邻顶底分型直接连笔，不限K线数，只要求顶高于底。最灵敏，噪音也最大。",
  "endpoint.extreme":
    "同向出现多个分型时，端点延伸到更高的顶／更低的底，端点总是区间极值。",
  "endpoint.first":
    "保留首个同型分型作端点，之后更极端的分型不再挪动端点；端点可能是次高／次低点。",
  "segment.heuristic": "用保护点简化判断线段结束。计算简单，非原文口径。",
  "segment.feature":
    "用特征序列分型判断线段结束，区分有无缺口两种情况（有缺口需反向特征序列确认）。贴近原文。",
  "segmentEnd.extreme":
    "分界点画在合并后特征元素中极值所在的那根笔上，即线段的真实最高／最低点。",
  "segmentEnd.first":
    "分界点画在合并后特征元素的第一根原始笔起点。只改画线位置，线段划分、中枢、背驰和买卖点仍按真实极值计算。",
  "segmentEnd.last":
    "分界点画在合并后特征元素的最后一根原始笔起点。只改画线位置，分析仍按真实极值；未发生包含时与极值笔相同。",
};

/** Relative sensitivity on the SSE regression sample (czsc-tdx v7 reply). */
export const czscStrokeSample =
  "上证指数样本端点数：老笔158 · 新笔180 · czsc笔208 · 4K笔208 · 分型笔718";

/** Note for an option row; keys shared across places are told apart by place. */
export const czscOptionNote = (o: Pick<CzscConfigOption, "key" | "place">) =>
  czscOptionNotes[`${o.key}@${o.place}`] ?? czscOptionNotes[o.key];

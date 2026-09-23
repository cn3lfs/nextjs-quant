import { z } from "zod";
import { asOfTimestampSchema as timestamp, type AsOfDomain } from "../evidence/as-of";
import { researchDateSchema as date } from "../workflow/research-usage";
import { symbolSchema } from "../../domain";
const text = z.string().trim().min(1),
  n = z.number().finite(),
  pos = n.positive(),
  pct = n.min(0).max(100),
  count = n.int().min(0),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const mapping = z
  .object({
    version: text,
    frozenAt: timestamp,
    availableAt: timestamp,
    capturedAt: timestamp,
    validFrom: date,
    validThrough: date,
    rows: z
      .array(
        z
          .object({ symbol: symbolSchema, industryId: text, evidence: text })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (r) =>
      r.validFrom <= r.validThrough &&
      new Set(r.rows.map((x) => x.symbol)).size === r.rows.length,
  );
export const newsReplaySchema = z
  .object({
    archiveId: text,
    queryStart: timestamp,
    queryEnd: timestamp,
    collectionEvidence: text,
    origin: z.enum(["rule", "human", "llm"]),
    rawInput: z.string().min(1),
    rawInputHash: hash,
    prompt: z.string().min(1),
    promptHash: hash,
    promptVersion: text,
    modelVersion: text,
    modelAvailableAt: timestamp,
    classificationVersion: text,
    companyMapping: mapping,
    industryMapping: mapping,
    firstProcessedAt: timestamp,
    firstResult: z.string().min(1),
    firstResultHash: hash,
    pipelineVersion: z.enum(["locked-qualitative-v1", "flow-enhanced-v2"]),
  })
  .strict();
export const rawNewsSchema = z
  .array(
    z
      .object({
        id: text,
        text: text,
        source: text,
        publishedAt: timestamp,
        firstCapturedAt: timestamp,
        firstAvailableAt: timestamp.nullable(),
      })
      .strict(),
  )
  .min(1)
  .refine((r) => new Set(r.map((x) => x.id)).size === r.length);
const impactKinds = [
  "policy",
  "technology",
  "demand",
  "cost-price",
  "competition",
  "capital",
] as const;
const event = z
  .object({
    id: text,
    newsIds: z.array(text).min(1),
    industryId: text,
    polarity: z.enum(["positive", "negative", "neutral"]),
    causal: z.boolean(),
    newInformation: z.boolean(),
    materialPct: nonnegative(),
    authority: z.enum(["official", "authoritative", "rumor"]),
    persistentDamage: z.boolean(),
    oneOffCovered: z.boolean(),
    denied: z.boolean(),
    expiresAt: date,
    authenticity: z
      .object({
        authority: pct,
        crossCheck: pct,
        logic: pct,
        timeliness: pct,
        trackRecord: pct,
        officialConfirmation: z.boolean(),
        singleAnonymous: z.boolean(),
        vague: z.boolean(),
        silent: z.boolean(),
      })
      .strict(),
    impacts: z.array(
      z
        .object({
          kind: z.enum(impactKinds),
          symbol: symbolSchema,
          role: z.enum(["direct", "supplier", "customer", "competitor"]),
          direction: z.enum(["positive", "negative"]),
          path: z.array(text).min(2),
          evidenceIds: z.array(text).min(1),
          expiresAt: date,
        })
        .strict(),
    ),
    catalyst: z
      .object({
        metric: text,
        threshold: n,
        observed: n,
        operator: z.enum(["gte", "lte"]),
        due: date,
        observedAt: timestamp,
        evidenceIds: z.array(text).min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
function nonnegative() {
  return n.min(0);
}
const grade = z.number().int().min(0).max(4);
export const chainSchema = z
  .object({
    industryId: text,
    evidenceIds: z.array(text).min(1),
    // Ordered source columns (weakest to strongest), midpoint engineering version.
    prosperity: z
      .object({
        inventory: z.tuple([grade, grade, grade, grade]),
        capacity: z.tuple([grade, grade, grade, grade]),
        demand: z.tuple([grade, grade, grade, grade]),
        profit: z.tuple([grade, grade, grade, grade]),
        policy: z.tuple([grade, grade, grade]),
      })
      .strict(),
    bottleneck: z
      .object({
        noSubstitute: z.boolean(),
        substituteCost: pos,
        suppliers: count,
        cr5: pct,
        cr3: pct,
        expansionMonths: nonnegative(),
        certificationMonths: nonnegative(),
        coverage: count,
        barrier: z.boolean(),
        certificationDominates: z.boolean(),
        technicalGapPct: pct,
        commercialCostRatio: pos,
        priceWar: z.boolean(),
        evidenceScores: z.tuple([
          z.number().int().min(0).max(2),
          z.number().int().min(0).max(2),
          z.number().int().min(0).max(2),
          z.number().int().min(0).max(2),
        ]),
        supplySeverity: z.enum(["fatal", "severe", "medium", "mild"]),
        refuted: z.boolean(),
        recognition: z.enum(["huge", "large", "normal", "priced"]),
      })
      .strict(),
    horizons: z
      .object({
        longYears: n.min(3).max(5),
        longPositive: z.boolean(),
        mediumYears: n.min(1).max(3),
        policyPositive: z.boolean(),
        shortMonths: n.min(0).lt(12),
        catalystPositive: z.boolean(),
        expiresAt: date,
      })
      .strict(),
  })
  .strict();
export const newsResultSchema = z
  .object({
    events: z.array(event).min(1),
    chain: chainSchema.optional(),
    themes: z
      .array(
        z
          .object({
            id: text,
            industries: z.array(text).min(2),
            evidenceIds: z.array(text).min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .refine((r) => new Set(r.events.map((x) => x.id)).size === r.events.length);
const bar = z
  .object({
    date,
    close: pos,
    high: pos,
    low: pos,
    volume: pos,
    sectorClose: pos,
    indexClose: pos,
    indexLow: pos,
    sectorUpPct: pct,
    marketUpPct: pct,
    resonatingUp: count,
    resonatingDown: count,
    marketAmountRatio: pos,
  })
  .strict()
  .refine(
    (b) => b.low <= b.close && b.close <= b.high && b.indexLow <= b.indexClose,
  );
export const eventMarketSchema = z
  .object({
    eventId: text,
    symbol: symbolSchema,
    industryId: text,
    version: text,
    evidence: text,
    baselineAt: timestamp,
    eventSession: date,
    calendar: z.array(date).min(2),
    bars: z.array(bar).min(2),
    heldOctant: z.number().int().min(1).max(8).nullable(),
    entrySession: date.nullable(),
    heldScope: z.enum(["stock", "sector", "market"]).nullable(),
    previousClose: pos,
    previousSectorClose: pos,
    previousIndexClose: pos,
    prior20ExcessPct: n,
    high60: pos,
    volumeMean20: pos,
    leader: z.boolean(),
    overheatCount: count,
    failedNewHighDays: count,
    breakout: z.boolean(),
    belowMa20: z.boolean(),
    peakSinceEntry: pos,
    previouslyExited: z.boolean(),
    stable: z.boolean(),
    pullbackVolumeRatio: nonnegative(),
    reboundVolumeRatio: nonnegative(),
    positionProfitable: z.boolean(),
    supportHeld: z.boolean(),
    netFlowPositive: z.boolean(),
  })
  .strict()
  .refine(
    (p) =>
      ((p.heldOctant === null &&
        p.entrySession === null &&
        p.heldScope === null) ||
        (p.heldOctant !== null &&
          p.entrySession !== null &&
          p.heldScope !== null &&
          p.calendar.includes(p.entrySession))) &&
      p.calendar[0] === p.eventSession &&
      p.calendar.length === p.bars.length &&
      p.calendar.every(
        (d, i) => (i === 0 || d > p.calendar[i - 1]!) && d === p.bars[i]!.date,
      ),
  );
export const newsSectorPanelSchema = z
  .object({
    calculationDate: date,
    windowStart: date,
    windowEnd: date,
    calendar: z.array(date).min(5),
    version: text,
    evidence: text,
    classificationVersion: text,
    rows: z
      .array(
        z
          .object({
            industryId: text,
            peHistory: z.array(pos).min(5),
            pbHistory: z.array(pos).min(5),
            flow5: z.tuple([n, n, n, n, n]).nullable(),
            flowScope: z.literal("SW-level1-and-level2"),
            children: z.array(
              z
                .object({ industryId: text, flow5: z.tuple([n, n, n, n, n]) })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (p) =>
      p.windowStart === p.calendar[0] &&
      p.windowEnd === p.calendar.at(-1) &&
      p.calculationDate === p.windowEnd &&
      p.calendar.every((d, i) => i === 0 || d > p.calendar[i - 1]!) &&
      new Set(p.rows.map((r) => r.industryId)).size === p.rows.length &&
      p.rows.every(
        (r) =>
          r.peHistory.length === p.calendar.length &&
          r.pbHistory.length === p.calendar.length &&
          new Set(r.children.map((c) => c.industryId)).size ===
            r.children.length,
      ),
  );
export const newsFactorRules: Record<string, string> = {
  ...Object.fromEntries(
    Array.from({ length: 13 }, (_, i) => [
      `EV${String(i + 1).padStart(2, "0")}`,
      `共享消息价格扩散八象限/迁移具名工程版${i + 1}；个股/板块/市场范围独立保留`,
    ]),
  ),
  NW01: "冻结分类结果计数Top7且>=2条，分类器仅输入组件；旧/新分类缓存分别归档",
  NW02: "方向与具日期可证伪催化；旧定性版与新实测资金增强版独立",
  NW03: "新闻热点叠加完整冻结PE/PB窗口低分位<30过滤；不填当前估值或重分配缺失权重",
  NW04: "冻结跨板块主线与行业五日八象限；新版本增加一级与二级五日资金排序；不把资金方向叫真实机构身份",
  ME01: "真实性30/30/20/10/10，>=80准入；正式辟谣硬否决；缺历史准确率不填55",
  ME02: "六类影响与直接/供应商/客户/竞争对手路径分别保留，证据/方向/失效日期校验",
  ME03: "消息验证后用同一八象限价格确认，不用模型自由写象限替代确定性计算",
  ME04: "消息证伪/过期/催化逾期未达退出优先；不因重新生成模型结论撤销",
  IC01: "五维景气及19子项按来源权重，区间中点10/30/50/70/90工程版，>=60筛选",
  IC02: "四特征含不可替代硬门槛、>=3星条件、断供严重/致命、证据>=6/8与反证，五种瓶颈独立",
  IC03: "催化已到观察时点且数值越过冻结阈值；过期/证伪优先退出",
  IC04: "3-5年长期、1-3年政策、12月内催化三层分别存在且同向；过期退出",
  IC05: "只消费已存档业务/供应链路径，直接间接受益分别候选；无路径不推断相关性",
  ...Object.fromEntries(
    ["inventory", "capacity", "demand", "profit", "policy"].map((k) => [
      `IC01-${k}`,
      `独立${k}景气组件`,
    ]),
  ),
  ...Object.fromEntries(
    [
      "technology",
      "supply",
      "verification",
      "commercialization",
      "competition",
    ].map((k) => [`IC02-${k}`, `独立${k}瓶颈组件`]),
  ),
};
export const octantParameters = {
  stock: {
    version: "event-two-session-v1",
    sessions: 2,
    excess: 3,
    volume: 1,
    sectorExcess: 2,
  },
  industry: {
    version: "industry-five-session-v1",
    sessions: 5,
    excess: 3,
    volume: 1.2,
    sectorExcess: 2,
  },
} as const;
type Event = z.infer<typeof event>;
type Market = z.infer<typeof eventMarketSchema>;
function authenticity(e: Event) {
  const s = e.authenticity;
  return e.denied
    ? 0
    : Math.max(
        0,
        Math.min(
          100,
          0.3 * s.authority +
            0.3 * s.crossCheck +
            0.2 * s.logic +
            0.1 * s.timeliness +
            0.1 * s.trackRecord +
            (s.officialConfirmation ? 15 : 0) -
            (s.singleAnonymous ? 20 : 0) -
            (s.vague ? 10 : 0) -
            (s.silent ? 5 : 0),
        ),
      );
}
export function evaluateNewsOctants(
  e: Event,
  p: Market,
  flavor: keyof typeof octantParameters = "stock",
) {
  const parameter = octantParameters[flavor],
    last = p.bars.at(-1)!,
    first = p.bars[0]!,
    anchor =
      flavor === "industry" ? p.bars.at(-parameter.sessions - 1) : undefined,
    ret = (last.close / (anchor?.close ?? p.previousClose) - 1) * 100,
    sectorRet =
      (last.sectorClose / (anchor?.sectorClose ?? p.previousSectorClose) - 1) *
      100,
    indexRet =
      (last.indexClose / (anchor?.indexClose ?? p.previousIndexClose) - 1) *
      100;
  const daily = p.bars.map((b, i) => ({
    sector:
      100 *
      (b.sectorClose / (p.bars[i - 1]?.sectorClose ?? p.previousSectorClose) -
        1),
    index:
      100 *
      (b.indexClose / (p.bars[i - 1]?.indexClose ?? p.previousIndexClose) - 1),
    up: b.sectorUpPct,
  }));
  const lastDay = daily.at(-1)!;
  const excess =
      flavor === "industry"
        ? ret - indexRet
        : ret - Math.max(sectorRet, indexRet),
    negativeExcess =
      flavor === "industry"
        ? ret - indexRet
        : ret - Math.min(sectorRet, indexRet),
    volume = last.volume / p.volumeMean20;
  const direction =
    volume > parameter.volume
      ? excess >= parameter.excess
        ? "up"
        : negativeExcess <= -parameter.excess
          ? "down"
          : "flat"
      : "flat";
  const down = direction === "down",
    marketShare = down ? 100 - last.marketUpPct : last.marketUpPct,
    sectorShare = down ? 100 - last.sectorUpPct : last.sectorUpPct,
    resonance = down ? last.resonatingDown : last.resonatingUp;
  const market =
    resonance >= 3 ||
    marketShare >= 70 ||
    ((down ? lastDay.index <= -2 : lastDay.index >= 2) &&
      (last.marketAmountRatio >= 1.5 || last.marketAmountRatio <= 0.5));
  const sector =
    sectorShare >= 60 &&
    (down
      ? lastDay.sector - lastDay.index <= -2
      : lastDay.sector - lastDay.index >= 2);
  const scope = market ? "market" : sector ? "sector" : "stock";
  const smallKnown =
    Math.abs(lastDay.sector) <= 1 &&
    last.sectorUpPct >= 40 &&
    last.sectorUpPct <= 60;
  const valid =
    p.bars.length >= parameter.sessions &&
    e.causal &&
    e.newInformation &&
    e.materialPct >= 5 &&
    e.authority !== "rumor" &&
    !e.denied &&
    e.polarity !== "neutral";
  const good = e.polarity === "positive",
    large = scope !== "stock",
    octant =
      direction === "flat" || !valid || (!large && !smallKnown)
        ? null
        : good
          ? direction === "up"
            ? large
              ? 2
              : 1
            : large
              ? 4
              : 3
          : direction === "down"
            ? large
              ? 6
              : 5
            : large
              ? 8
              : 7;
  const drawdown = (1 - p.previousClose / p.high60) * 100,
    stop = first.low,
    reclaimed =
      last.close > first.high &&
      p.reboundVolumeRatio > 1.2 &&
      p.stable &&
      p.pullbackVolumeRatio < 1 / 3;
  let enter = false,
    hold = false,
    reduce = false,
    forbid = true,
    targetCapPct: number | null = null,
    scopeOut = scope,
    reason = "未满足价格/消息/扩散确认";
  if (octant === 1) {
    hold = true;
    enter = drawdown > 15 && p.breakout;
    reduce = p.belowMa20 || last.close <= p.peakSinceEntry * 0.92;
    forbid = !enter || reduce;
    reason = "低位突破加仓，高位持有不追；MA20/8%回撤减半";
  }
  if (octant === 2) {
    hold = true;
    enter =
      p.leader &&
      p.overheatCount < 2 &&
      daily.slice(-2).every((d) => d.up >= 60 && d.sector - d.index >= 2);
    reduce = p.overheatCount >= 2 && p.failedNewHighDays >= 2;
    forbid = !enter || reduce;
    targetCapPct = reduce ? 30 : 80;
    reason = "龙头顺势，过热两项且两日未新高退防守";
  }
  if (octant === 3) {
    reduce = true;
    reason = "仅该股减半；缩量1/3且放量收复公告高点后才回补";
  }
  if (octant === 4) {
    reduce = true;
    targetCapPct = 30;
    reason = "板块或市场防守线30%，禁止换股冒充降仓";
  }
  if (octant === 5) {
    hold = !e.persistentDamage && e.oneOffCovered;
    reduce = !hold;
    targetCapPct = hold ? null : 0;
    reason = "持续伤害离场，一次性量化覆盖才允许持有；禁止接飞刀";
  }
  if (octant === 6) {
    reduce = true;
    targetCapPct = 30;
    reason = "风险作用范围内仓位30%、杠杆0；仅市场扩散才调整总仓";
  }
  if (octant === 7) {
    enter = drawdown > 30 && last.close >= stop;
    hold = enter;
    forbid = !enter;
    targetCapPct =
      p.positionProfitable && p.supportHeld && p.pullbackVolumeRatio < 1
        ? 12.5
        : 10;
    reduce = last.close < stop;
    reason = "深跌后10%试探，公告低点证伪；盈利且缩量守位加至标准仓一半";
  }
  if (octant === 8) {
    enter = p.leader && p.supportHeld && p.netFlowPositive;
    hold = enter;
    reduce = last.close < stop;
    forbid = !enter || reduce;
    targetCapPct = reduce ? 30 : 70;
    reason = "抗跌龙头分批，首笔目标30%；公告低点证伪回防守";
  }
  if (e.denied || (last.close < stop && [7, 8].includes(octant ?? 0))) {
    enter = false;
    hold = false;
    reduce = true;
    forbid = true;
    targetCapPct = octant === 8 ? 30 : 0;
  }
  return {
    parameter,
    octant,
    scope: scopeOut,
    observedScope: scope,
    direction,
    excess,
    negativeExcess,
    volume,
    drawdown,
    enter: enter && !forbid && (flavor === "industry" || p.bars.length <= 3),
    hold,
    reduce,
    forbid,
    targetCapPct,
    reduceFraction: [1, 3].includes(octant ?? 0) && reduce ? 0.5 : null,
    firstTargetFraction: octant === 8 ? 0.3 : 1,
    stop,
    reclaimed,
    reason,
    leveragedAllowed: octant !== 6,
  };
}
export function newsFactorInputs(
  id: string,
  at: string,
): { domain: AsOfDomain; field: string; effectiveAt: string }[] {
  return [
    "newsReplay",
    ...(id.startsWith("EV") || id === "ME03" || id === "NW04"
      ? ["eventMarket"]
      : []),
    ...(["NW03", "NW04"].includes(id) ? ["newsSectorPanel"] : []),
  ].map((field) => ({ domain: "catalysts", field, effectiveAt: at }));
}
export function evaluateNewsFactor(
  id: string,
  req: { symbol: string; observationDate: string; asOf: string },
  read: (domain: AsOfDomain, field: string, at: string) => unknown,
) {
  const take = (field: string) => read("catalysts", field, req.observationDate),
    a = newsReplaySchema.parse(take("newsReplay")),
    raw = rawNewsSchema.parse(JSON.parse(a.rawInput)),
    result = newsResultSchema.parse(JSON.parse(a.firstResult));
  const cutoff = Math.min(
      Date.parse(req.asOf),
      Date.parse(`${req.observationDate}T15:00:00+08:00`),
    ),
    limits: string[] = [];
  if (
    Date.parse(a.queryStart) > Date.parse(a.queryEnd) ||
    Date.parse(a.queryEnd) > Date.parse(a.firstProcessedAt) ||
    raw.some(
      (r) =>
        Date.parse(r.publishedAt) < Date.parse(a.queryStart) ||
        Date.parse(r.publishedAt) > Date.parse(a.queryEnd),
    )
  )
    throw new Error("新闻原始集合必须对应冻结采集窗口");
  const times = [
    a.firstProcessedAt,
    a.modelAvailableAt,
    a.companyMapping.frozenAt,
    a.companyMapping.availableAt,
    a.companyMapping.capturedAt,
    a.industryMapping.frozenAt,
    a.industryMapping.availableAt,
    a.industryMapping.capturedAt,
  ];
  if (times.some((t) => Date.parse(t) > cutoff))
    limits.push(
      "回溯性文本实验：使用决策日后模型/映射/处理结果，不能作为历史已知信号",
    );
  for (const r of raw) {
    if (Date.parse(r.publishedAt) > cutoff)
      limits.push(`消息发布晚于决策:${r.id}`);
    if (
      Date.parse(r.firstCapturedAt) < Date.parse(r.publishedAt) ||
      (r.firstAvailableAt &&
        Date.parse(r.firstAvailableAt) < Date.parse(r.publishedAt))
    )
      throw new Error("采集/首次可用不得早于发布");
    if (!r.firstAvailableAt) limits.push(`缺首次可用时点:${r.id}`);
    if (Date.parse(r.firstCapturedAt) > cutoff)
      limits.push(`新闻首次采集晚于决策:${r.id}`);
    if (
      Date.parse(r.publishedAt) > Date.parse(a.firstProcessedAt) ||
      Date.parse(r.firstCapturedAt) > Date.parse(a.firstProcessedAt) ||
      (r.firstAvailableAt &&
        Date.parse(r.firstAvailableAt) > Date.parse(a.firstProcessedAt))
    )
      throw new Error("处理时间早于输入发布/采集/可用时间");
  }
  if (Date.parse(a.modelAvailableAt) > Date.parse(a.firstProcessedAt))
    throw new Error("模型版本尚未发布");
  for (const m of [a.companyMapping, a.industryMapping]) {
    if (
      m.validFrom > req.observationDate ||
      m.validThrough < req.observationDate
    )
      limits.push("公司/行业映射不覆盖历史决策日期");
    if (
      Date.parse(m.availableAt) > Date.parse(m.frozenAt) ||
      Date.parse(m.capturedAt) > Date.parse(m.frozenAt)
    )
      throw new Error("映射缺冻结前可知/归档证明");
  }
  const company = a.companyMapping.rows.find((x) => x.symbol === req.symbol),
    industry = a.industryMapping.rows.find((x) => x.symbol === req.symbol);
  if (!company || !industry || company.industryId !== industry.industryId)
    throw new Error("冻结公司与行业映射不一致");
  const known = new Set(raw.map((r) => r.id));
  const evidence = (ids: string[]) => {
    if (ids.some((x) => !known.has(x)))
      throw new Error("结构化结果引用不存在的原文");
  };
  for (const e of result.events) {
    evidence(e.newsIds);
    for (const i of e.impacts) evidence(i.evidenceIds);
    if (e.catalyst) {
      evidence(e.catalyst.evidenceIds);
      if (Date.parse(e.catalyst.observedAt) > Date.parse(a.firstProcessedAt))
        throw new Error("首次结果包含未来催化观察");
    }
  }
  if (result.chain) evidence(result.chain.evidenceIds);
  for (const t of result.themes ?? []) evidence(t.evidenceIds);
  const target = result.events.filter(
      (e) => e.industryId === industry.industryId,
    ),
    e = target[0];
  if (!e) throw new Error("没有目标行业的冻结事件");
  const expired = e.expiresAt < req.observationDate,
    cat = e.catalyst,
    catalyst =
      !!cat &&
      Date.parse(cat.observedAt) <= Date.parse(req.asOf) &&
      (cat.operator === "gte"
        ? cat.observed >= cat.threshold
        : cat.observed <= cat.threshold),
    invalid =
      e.denied ||
      expired ||
      (!!cat && cat.due < req.observationDate && !catalyst);
  let enter = false,
    exit = invalid,
    actionOverride: string | null = null,
    details: Record<string, unknown> = {};
  if (id.startsWith("EV") || id === "ME03" || id === "NW04") {
    const p = eventMarketSchema.parse(take("eventMarket")),
      ev = result.events.find((x) => x.id === p.eventId);
    if (
      !ev ||
      ev.id !== e.id ||
      p.symbol !== req.symbol ||
      p.industryId !== industry.industryId ||
      p.calendar.at(-1) !== req.observationDate ||
      Date.parse(p.baselineAt) >=
        Math.min(
          ...ev.newsIds.map((x) =>
            Date.parse(raw.find((r) => r.id === x)!.publishedAt),
          ),
        ) ||
      ev.newsIds.some(
        (x) =>
          Date.parse(raw.find((r) => r.id === x)!.publishedAt) >
          Date.parse(`${p.eventSession}T15:00:00+08:00`),
      )
    )
      throw new Error("事件/行情/基准时点不匹配");
    const q = evaluateNewsOctants(ev, p, id === "NW04" ? "industry" : "stock");
    details = { ...q };
    const number = Number(id.slice(2)),
      match = id === "ME03" || id === "NW04" || q.octant === number;
    enter = match && q.enter;
    exit = invalid || (match && q.reduce && q.targetCapPct === 0);
    actionOverride =
      match && q.reduce ? (q.targetCapPct === 0 ? "exit" : "reduce") : null;
    if (id === "EV09") {
      enter = false;
      exit = invalid;
      actionOverride =
        ev.polarity === "positive" &&
        p.prior20ExcessPct >= 10 &&
        (q.direction === "down" || p.belowMa20)
          ? "reduce"
          : null;
      details.reduceFraction = 0.5;
    }
    if (id === "EV10") {
      enter =
        ev.polarity === "negative" &&
        q.drawdown > 30 &&
        (q.direction === "up" ||
          (q.direction === "flat" && p.stable && p.supportHeld)) &&
        p.bars.at(-1)!.close >= q.stop;
      exit = invalid || p.bars.at(-1)!.close < q.stop;
      details.targetCapPct = 10;
    }
    if (id === "EV11") {
      enter =
        ev.polarity === "negative" &&
        q.direction === "flat" &&
        p.stable &&
        q.drawdown > 30;
      exit = invalid;
      actionOverride =
        ev.polarity === "positive" && q.direction === "flat" ? "reduce" : null;
      details.targetCapPct = 10;
    }
    if (id === "EV12") {
      enter =
        q.observedScope !== "stock" &&
        q.direction === "up" &&
        p.leader &&
        p.overheatCount < 2;
      exit = invalid;
      actionOverride =
        q.direction === "down" && q.observedScope !== "stock" ? "reduce" : null;
      details.targetCapPct = 30;
    }
    if (id === "EV13") {
      enter = p.previouslyExited && q.reclaimed && !ev.denied;
      exit = invalid || p.bars.at(-1)!.close < q.stop;
    }
    if (
      !ev.causal ||
      !ev.newInformation ||
      ev.materialPct < 5 ||
      ev.authority === "rumor"
    )
      enter = false;
    const held = p.heldOctant,
      last = p.bars.at(-1)!,
      age =
        p.entrySession === null
          ? null
          : p.bars.length - 1 - p.calendar.indexOf(p.entrySession);
    if (
      held !== null &&
      (id === `EV${String(held).padStart(2, "0")}` ||
        id === "ME03" ||
        id === "NW04")
    ) {
      const protect =
          held === 1 &&
          (p.belowMa20 ||
            last.close <= p.peakSinceEntry * 0.92 ||
            (age !== null && age <= 3 && last.close < p.previousClose)),
        cool = held === 2 && p.overheatCount >= 2 && p.failedNewHighDays >= 2,
        broken = held === 7 && last.close < p.bars[0]!.low,
        marketBroken =
          held === 8 &&
          age !== null &&
          age <= 3 &&
          last.indexClose < p.bars[0]!.indexLow;
      if (protect || cool || broken || marketBroken) {
        enter = false;
        exit = invalid || broken;
        actionOverride = broken ? "exit" : "reduce";
        details = {
          ...details,
          heldOctant: held,
          scope: p.heldScope,
          reduce: true,
          forbid: true,
          enter: false,
          targetCapPct: broken ? 0 : cool || marketBroken ? 30 : null,
          reduceFraction: protect ? 0.5 : null,
          reason: "原入场象限的证伪锁定，不因迁移到其他象限撤销",
        };
      }
    }
  }
  if (id === "ME03") {
    const score = authenticity(e);
    enter = enter && score >= 80;
    details = { ...details, authenticity: score };
  }
  if (id.startsWith("ME") && id !== "ME03") {
    const s = e.authenticity;
    const score = e.denied
      ? 0
      : Math.max(
          0,
          Math.min(
            100,
            0.3 * s.authority +
              0.3 * s.crossCheck +
              0.2 * s.logic +
              0.1 * s.timeliness +
              0.1 * s.trackRecord +
              (s.officialConfirmation ? 15 : 0) -
              (s.singleAnonymous ? 20 : 0) -
              (s.vague ? 10 : 0) -
              (s.silent ? 5 : 0),
          ),
        );
    const paths = e.impacts.filter(
      (i) => i.symbol === req.symbol && i.expiresAt >= req.observationDate,
    );
    enter =
      id === "ME01"
        ? score >= 80
        : id === "ME02"
          ? score >= 80 && paths.some((i) => i.direction === "positive")
          : !invalid;
    if (id === "ME02" && paths.some((i) => i.direction === "negative")) {
      enter = false;
      exit = true;
    }
    details = {
      authenticity: score,
      paths,
      impactKinds,
      catalystVerified: catalyst,
    };
  }
  if (id.startsWith("NW")) {
    const counts = new Map<string, Set<string>>();
    for (const v of result.events) {
      if (["宏观", "市场情绪面", "国际市场"].includes(v.industryId)) continue;
      const ids = counts.get(v.industryId) ?? new Set<string>();
      for (const newsId of v.newsIds) ids.add(newsId);
      counts.set(v.industryId, ids);
    }
    const hot = [...counts]
        .map(([industryId, ids]) => ({ industryId, count: ids.size }))
        .filter((r) => r.count >= 2)
        .sort(
          (x, y) =>
            y.count - x.count || x.industryId.localeCompare(y.industryId),
        )
        .slice(0, 7),
      isHot = hot.some((x) => x.industryId === industry.industryId);
    let flowPass = true,
      panelDetails: Record<string, unknown> = {};
    if (
      id === "NW03" ||
      id === "NW04" ||
      (id === "NW02" && a.pipelineVersion === "flow-enhanced-v2")
    ) {
      const p = newsSectorPanelSchema.parse(take("newsSectorPanel")),
        row = p.rows.find((x) => x.industryId === industry.industryId);
      if (
        !row ||
        p.calculationDate !== req.observationDate ||
        p.classificationVersion !== a.classificationVersion
      )
        throw new Error("冻结估值/资金池与分类或日期不匹配");
      const rank = (xs: number[]) =>
        (100 * xs.filter((x) => x < xs.at(-1)!).length) / xs.length;
      panelDetails = {
        pePercentile: rank(row.peHistory),
        pbPercentile: rank(row.pbHistory),
        window: { start: p.windowStart, end: p.windowEnd },
      };
      if (a.pipelineVersion === "flow-enhanced-v2") {
        if (!row.flow5 || !row.children.length)
          throw new Error(
            "资金增强版本缺一级/二级完整五日实测，不降级旧定性版",
          );
        const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0),
          flow = sum(row.flow5),
          children = row.children
            .map((x) => ({ industryId: x.industryId, flow: sum(x.flow5) }))
            .sort(
              (x, y) =>
                y.flow - x.flow || x.industryId.localeCompare(y.industryId),
            );
        flowPass = flow > 0;
        panelDetails = {
          ...panelDetails,
          flow,
          children,
          messageFlowDivergence: (e.polarity === "positive") !== flow > 0,
        };
      }
    }
    if (id === "NW01") enter = isHot;
    if (id === "NW02")
      enter = isHot && e.polarity === "positive" && catalyst && flowPass;
    if (id === "NW03")
      enter =
        isHot &&
        e.polarity === "positive" &&
        (panelDetails.pePercentile as number) < 30 &&
        (panelDetails.pbPercentile as number) < 30 &&
        flowPass;
    if (id === "NW04")
      enter =
        enter &&
        isHot &&
        flowPass &&
        (result.themes ?? []).some((t) =>
          t.industries.includes(industry.industryId),
        );
    details = {
      ...details,
      ...panelDetails,
      hot,
      pipelineVersion: a.pipelineVersion,
      classificationVersion: a.classificationVersion,
      classifierRole: "input-component-not-trading-strategy",
    };
  }
  if (id.startsWith("IC")) {
    const c = result.chain;
    if (!c || c.industryId !== industry.industryId)
      throw new Error("缺冻结产业链结构化证据");
    const weights = {
        inventory: [0.3, 0.3, 0.2, 0.2],
        capacity: [0.35, 0.3, 0.2, 0.15],
        demand: [0.3, 0.3, 0.25, 0.15],
        profit: [0.35, 0.3, 0.2, 0.15],
        policy: [0.4, 0.35, 0.25],
      },
      scores = Object.fromEntries(
        Object.entries(weights).map(([k, w]) => [
          k,
          w.reduce(
            (s, v, i) =>
              s + v * (10 + 20 * c.prosperity[k as keyof typeof weights][i]!),
            0,
          ),
        ]),
      ),
      total =
        0.2 * scores.inventory! +
        0.25 * scores.capacity! +
        0.3 * scores.demand! +
        0.15 * scores.profit! +
        0.1 * scores.policy!;
    const b = c.bottleneck,
      hard = b.noSubstitute || b.substituteCost > 3,
      oligopoly = b.suppliers <= 5 && b.cr5 > 70,
      rigid = b.expansionMonths > 12 && b.barrier,
      stars =
        Number(hard) +
        Number(oligopoly) +
        Number(rigid) +
        Number(b.coverage < 5),
      proof = b.evidenceScores.reduce((s, x) => s + x, 0),
      types = {
        technology: hard && !rigid && b.technicalGapPct > 0,
        supply: hard && oligopoly && rigid,
        verification:
          rigid && b.certificationDominates && b.certificationMonths > 24,
        commercialization: b.commercialCostRatio > 2,
        competition: b.cr3 > 80 || (b.cr5 < 20 && b.priceWar),
      },
      bottleneck =
        hard &&
        stars >= 3 &&
        proof >= 6 &&
        ["fatal", "severe"].includes(b.supplySeverity) &&
        !b.refuted &&
        b.recognition !== "priced";
    if (id === "IC01") enter = total >= 60;
    else if (id.startsWith("IC01-")) enter = scores[id.slice(5)]! >= 60;
    else if (id === "IC02")
      enter = bottleneck && Object.values(types).some(Boolean);
    else if (id.startsWith("IC02-"))
      enter = bottleneck && types[id.slice(5) as keyof typeof types];
    else if (id === "IC03") enter = catalyst;
    else if (id === "IC04")
      enter =
        c.horizons.longPositive &&
        c.horizons.policyPositive &&
        c.horizons.catalystPositive &&
        c.horizons.expiresAt >= req.observationDate;
    else if (id === "IC05")
      enter = e.impacts.some(
        (i) =>
          i.symbol === req.symbol &&
          i.direction === "positive" &&
          i.expiresAt >= req.observationDate,
      );
    exit =
      invalid ||
      b.refuted ||
      (id === "IC04" && c.horizons.expiresAt < req.observationDate);
    details = {
      scores,
      total,
      stars,
      proof,
      types,
      bottleneck,
      horizons: c.horizons,
      paths: e.impacts.filter((i) => i.symbol === req.symbol),
      catalystVerified: catalyst,
    };
  }
  enter = enter && !invalid && !limits.length;
  return {
    points: Number(enter),
    participation: a.origin,
    details: {
      ...details,
      buyEligible: enter,
      exit: exit && !limits.length,
      action: limits.length
        ? "retrospective-only"
        : exit
          ? "exit"
          : (actionOverride ?? (enter ? "enter" : "hold")),
      limitations: [...new Set(limits)],
      archiveId: a.archiveId,
      rawInputHash: a.rawInputHash,
      promptHash: a.promptHash,
      modelVersion: a.modelVersion,
      firstResultHash: a.firstResultHash,
      firstProcessedAt: a.firstProcessedAt,
      companyMappingVersion: a.companyMapping.version,
      industryMappingVersion: a.industryMapping.version,
      executionBoundary:
        "冻结首次结构化结果离线重放，不调用模型；个股/板块/市场作用范围保留，只生成待数据候选；下一合法时点/T+1，普通单股25%、EV7/10/11试探10%、20日上限工程对照；不是历史业绩",
    },
  };
}

import { createHash } from "node:crypto";
import type { AsOfObservation } from "../../src/lib/as-of";
import { asOfInputDefinitions } from "../../src/lib/as-of-inputs";
import { request } from "./growth-factor-fixture";
export const newsRequest = request;
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function newsFixture(id = "EV01") {
  const number = id.startsWith("EV") ? Number(id.slice(2)) : NaN,
    negative = [5, 6, 7, 8, 10, 11].includes(number),
    down = [3, 4, 5, 6, 9].includes(number),
    large = [2, 4, 6, 8, 12].includes(number) || id === "NW04";
  const calendar =
    id === "NW04"
      ? ["2024-04-27", "2024-04-28", "2024-04-29", "2024-04-30", "2024-05-01"]
      : ["2024-04-29", "2024-04-30", "2024-05-01"];
  const raw = [1, 2].map((i) => ({
    id: `n${i}`,
    text: `合成公告${i}：订单增加，只用于测试`,
    source: "synthetic-official",
    publishedAt: `${calendar[0]}T08:00:00+08:00`,
    firstCapturedAt: `${calendar[0]}T08:01:00+08:00`,
    firstAvailableAt: `${calendar[0]}T08:00:00+08:00`,
  }));
  const e = {
    id: "event-1",
    newsIds: ["n1", "n2"],
    industryId: "电子",
    polarity: negative ? "negative" : "positive",
    causal: true,
    newInformation: true,
    materialPct: 10,
    authority: "official",
    persistentDamage: true,
    oneOffCovered: false,
    denied: false,
    expiresAt: "2024-06-01",
    authenticity: {
      authority: 90,
      crossCheck: 90,
      logic: 90,
      timeliness: 90,
      trackRecord: 90,
      officialConfirmation: false,
      singleAnonymous: false,
      vague: false,
      silent: false,
    },
    impacts: [
      {
        kind: "demand",
        symbol: request.symbol,
        role: "direct",
        direction: "positive",
        path: ["新增订单", "收入增长"],
        evidenceIds: ["n1"],
        expiresAt: "2024-06-01",
      },
    ],
    catalyst: {
      metric: "confirmedOrders",
      threshold: 10,
      observed: 12,
      operator: "gte",
      due: "2024-05-10",
      observedAt: "2024-05-01T14:00:00+08:00",
      evidenceIds: ["n1"],
    },
  };
  const chain = {
    industryId: "电子",
    evidenceIds: ["n1"],
    prosperity: {
      inventory: [4, 4, 4, 4],
      capacity: [4, 4, 4, 4],
      demand: [4, 4, 4, 4],
      profit: [4, 4, 4, 4],
      policy: [4, 4, 4],
    },
    bottleneck: {
      noSubstitute: true,
      substituteCost: 4,
      suppliers: 3,
      cr5: 90,
      cr3: 85,
      expansionMonths: id === "IC02-technology" ? 6 : 24,
      certificationMonths: 30,
      coverage: 2,
      barrier: true,
      certificationDominates: true,
      technicalGapPct: 60,
      commercialCostRatio: 4,
      priceWar: false,
      evidenceScores: [2, 2, 2, 2],
      supplySeverity: "severe",
      refuted: false,
      recognition: "huge",
    },
    horizons: {
      longYears: 4,
      longPositive: true,
      mediumYears: 2,
      policyPositive: true,
      shortMonths: 6,
      catalystPositive: true,
      expiresAt: "2024-06-01",
    },
  };
  const result = {
    events: [e],
    chain,
    themes: [
      {
        id: "synthetic-mainline",
        industries: ["电子", "计算机"],
        evidenceIds: ["n1", "n2"],
      },
    ],
  };
  const map = {
    version: "synthetic-asof-1",
    frozenAt: "2024-04-26T15:00:00+08:00",
    availableAt: "2024-04-26T14:00:00+08:00",
    capturedAt: "2024-04-26T14:00:00+08:00",
    validFrom: "2024-01-01",
    validThrough: "2024-12-31",
    rows: [
      {
        symbol: request.symbol,
        industryId: "电子",
        evidence: "synthetic-business-evidence",
      },
    ],
  };
  const rawInput = JSON.stringify(raw),
    prompt = "fixture-only classify evidence; never trade",
    firstResult = JSON.stringify(result);
  const replay = {
    archiveId: "synthetic-original-call-1",
    queryStart: "2024-04-27T00:00:00+08:00",
    queryEnd: "2024-05-01T14:58:00+08:00",
    collectionEvidence: "synthetic-complete-input-only",
    origin: "llm",
    rawInput,
    rawInputHash: digest(rawInput),
    prompt,
    promptHash: digest(prompt),
    promptVersion: "synthetic-prompt-1",
    modelVersion: "synthetic-model-1",
    modelAvailableAt: "2024-01-01T00:00:00Z",
    classificationVersion: "synthetic-cache-1",
    companyMapping: structuredClone(map),
    industryMapping: structuredClone(map),
    firstProcessedAt: "2024-05-01T14:59:00+08:00",
    firstResult,
    firstResultHash: digest(firstResult),
    pipelineVersion: "locked-qualitative-v1",
  };
  const market = {
    eventId: e.id,
    symbol: request.symbol,
    industryId: "电子",
    version: "synthetic-market-1",
    evidence: "synthetic-no-real-calendar",
    baselineAt: "2024-04-26T15:00:00+08:00",
    eventSession: calendar[0],
    calendar,
    bars: calendar.map((date, i) => ({
      date,
      close: down ? 97 - i : 101 + i * 3,
      high: down ? 99 - i : 102 + i * 3,
      low: down ? 95 - i : 99 + i * 3,
      volume: 200,
      sectorClose: large ? 100 + (down ? -3 : 3) * (i + 1) : 100,
      indexClose: 100,
      indexLow: 99,
      sectorUpPct: large ? (down ? 20 : 80) : 50,
      marketUpPct: [6, 8].includes(number) ? (down ? 20 : 80) : 50,
      resonatingUp: 0,
      resonatingDown: 0,
      marketAmountRatio: 1,
    })),
    heldOctant: null as number | null,
    entrySession: null as string | null,
    heldScope: null as "stock" | "sector" | "market" | null,
    previousClose: 100,
    previousSectorClose: 100,
    previousIndexClose: 100,
    prior20ExcessPct: 20,
    high60: 160,
    volumeMean20: 100,
    leader: true,
    overheatCount: 0,
    failedNewHighDays: 0,
    breakout: true,
    belowMa20: false,
    peakSinceEntry: 110,
    previouslyExited: id === "EV13",
    stable: true,
    pullbackVolumeRatio: 0.2,
    reboundVolumeRatio: 2,
    positionProfitable: false,
    supportHeld: true,
    netFlowPositive: true,
  };
  if (large && !down)
    for (const [i, b] of market.bars.entries()) {
      b.close = 110 + i * 5;
      b.high = b.close + 1;
      b.low = b.close - 1;
    } // beats both sector and market
  if (large && down)
    for (const [i, b] of market.bars.entries()) {
      b.close = 90 - i * 5;
      b.high = b.close + 1;
      b.low = b.close - 1;
    }
  if (id === "EV11")
    for (const b of market.bars) {
      b.close = 100;
      b.high = 101;
      b.low = 99;
    }
  if (id === "EV13") market.bars[0]!.high = 102;
  const panelCalendar = [
    "2024-04-27",
    "2024-04-28",
    "2024-04-29",
    "2024-04-30",
    "2024-05-01",
  ];
  const sector = {
    calculationDate: request.observationDate,
    windowStart: panelCalendar[0],
    windowEnd: request.observationDate,
    calendar: panelCalendar,
    version: "synthetic-sector-1",
    evidence: "fixture-only",
    classificationVersion: replay.classificationVersion,
    rows: [
      {
        industryId: "电子",
        peHistory: [20, 18, 16, 14, 12],
        pbHistory: [3, 2.8, 2.6, 2.4, 2.2],
        flow5: [1, 1, 1, 1, 1],
        flowScope: "SW-level1-and-level2",
        children: [{ industryId: "半导体", flow5: [1, 1, 1, 1, 1] }],
      },
    ],
  };
  return { replay, result, raw, market, sector };
}
export function newsRows(f = newsFixture()): AsOfObservation[] {
  f.replay.rawInput = JSON.stringify(f.raw);
  f.replay.rawInputHash = digest(f.replay.rawInput);
  f.replay.firstResult = JSON.stringify(f.result);
  f.replay.firstResultHash = digest(f.replay.firstResult);
  return Object.entries({
    newsReplay: f.replay,
    eventMarket: f.market,
    newsSectorPanel: f.sector,
  }).map(([field, value]) => ({
    domain: "catalysts",
    entity: request.symbol,
    field,
    effectiveAt: request.observationDate,
    source: "synthetic-frozen",
    availableAt: request.asOf,
    capturedAt: request.asOf,
    versionId: "synthetic-first-call-1",
    availabilityEvidence: {
      kind: "version-publication",
      reference: "fixture-only",
    },
    unit: asOfInputDefinitions.catalysts[field]!.unit,
    value,
  }));
}

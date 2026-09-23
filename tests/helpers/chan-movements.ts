import type { Bar } from "../../src/lib/domain";
import type {
  CzscFamily,
  CzscResult,
  CzscSignalStructure,
} from "../../src/lib/research/methods/chan/czsc";
import type { CzscMovements } from "../../src/lib/research/methods/chan/czsc-movements";
import { chanC4Trend } from "../../src/lib/research/methods/chan/research-chan-movements";
export function chanMovementFixture() {
  const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, "0")}`,
    open: 30 - i,
    close: 30 - i,
    high: 30 - i,
    low: 29 - i,
    volume: 100,
    amount: 1000,
  }));
  const center = (
    id: number,
    start: number,
    end: number,
    ZG: number,
    ZD: number,
  ) => ({
    id,
    level: 1,
    start,
    end,
    centerStart: start,
    centerEnd: end,
    established: end,
    connection: end,
    completed: end + 1,
    successorId: 0,
    children: [],
    high: ZG,
    low: ZD,
    ZG,
    ZD,
  });
  const table: CzscMovements = {
    version: "native-movements-c4-1",
    config: 0,
    anchor: 1,
    centers: [center(1, 2, 5, 28, 24), center(2, 10, 13, 20, 16)],
    connections: [],
    movements: [
      {
        id: 1,
        level: 1,
        type: -1,
        start: 0,
        end: 18,
        established: 13,
        completed: 19,
        successorId: 0,
        centerIds: [1, 2],
        connectionIds: [],
        high: 30,
        low: 11,
      },
    ],
    associations: [
      {
        id: 1,
        structureId: 1,
        movementId: 1,
        completionId: 1,
        level: 1,
        status: "verified",
        centerIds: [1, 2],
      },
    ],
  };
  const meta: CzscSignalStructure = {
    contextFlags: 1,
    pointId: 4,
    trendId: 1,
    breakoutId: 0,
    leavePointId: 0,
    retestPointId: 0,
    secondBasePointId: 0,
    secondTurnPointId: 0,
    smallTurnBasePointId: 0,
    smallTurnLeavePointId: 0,
    smallTurnRetestPointId: 0,
    previousStartPointId: 1,
    previousEndPointId: 2,
    currentStartPointId: 3,
    currentEndPointId: 4,
    centerLifecycle: 0,
  };
  const signal: CzscFamily["signals"][number] = {
    index: 18,
    date: bars[18]!.date,
    kind: 1,
    quality: 1,
    centerId: 2,
    structure: meta,
    divergence: {
      semantic: 1,
      flags: 17,
      areaRatio: 50,
      priceRatio: 0.5,
      speedRatio: 0.5,
    },
  };
  const family: CzscFamily = {
    config: 0,
    points: [0, 3, 14, 18].map((index, i) => ({
      index,
      date: bars[index]!.date,
      direction: i % 2 ? -1 : 1,
      price: i % 2 ? bars[index]!.low : bars[index]!.high,
    })),
    centers: table.centers.map((c) => ({
      start: c.centerStart,
      end: c.centerEnd,
      startDate: bars[c.centerStart]!.date,
      endDate: bars[c.centerEnd]!.date,
      direction: -1,
      ZG: c.ZG,
      ZD: c.ZD,
      GG: c.high,
      DD: c.low,
    })),
    signals: [signal],
    movements: [],
    qualities: [],
    divergences: [],
    native: {
      version: "native-projections-c2-1",
      config: 0,
      trends: [],
      highCandidates: [],
      completedSequence: "unavailable",
      recursiveMovements: table,
    },
  };
  const result: CzscResult = {
    status: "structure",
    hash: "fixed-only",
    sourceCommit: "b67f3c6",
    families: [family],
  };
  return {
    bars,
    table,
    signal,
    family,
    result,
    trend: () => chanC4Trend(result, bars, 0, signal),
  };
}

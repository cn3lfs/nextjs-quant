import type { CzscConfig, CzscProjection } from "~/lib/chart/czsc-settings";
// Mirrors adapter/czsc_api.h (czsc-tdx, api v20). Bar positions are zero-based
// raw bar indices; table references are zero-based indices into the same
// snapshot; -1 means none. confirmedAt is the earliest bar after which the
// object never changes (-1 = not final yet).

export type CzscRawDivergence = {
  prevStart: number;
  prevEnd: number;
  curStart: number;
  curEnd: number;
  prevSpace: number;
  prevSpeed: number;
  prevArea: number;
  curSpace: number;
  curSpeed: number;
  curArea: number;
  newExtreme: number;
  weakSpace: number;
  weakSpeed: number;
  weakArea: number;
  holds: number;
  /** 0 none / 1 trend (first class) / 2 consolidation */
  semantic: number;
};
export type CzscRawPivot = {
  /** v8: display boundary bar (segment 10000s digit); draw only. */
  index: number;
  kind: number;
  /** High/low of the display bar. */
  price: number;
  fractalAt: number;
  confirmedAt: number;
  /** v8: analysis endpoint bar (true extreme); equals index by default and for strokes. */
  extremeIndex: number;
};
export type CzscRawCenter = {
  start: number;
  end: number;
  firstPivot: number;
  lastPivot: number;
  zg: number;
  zd: number;
  gg: number;
  dd: number;
  direction: number;
  confirmedAt: number;
  relationToPrev: number;
  /** 0 extension / 1 expansion / 2 newborn up / 3 newborn down / -1 first */
  lifecycle: number;
  /** v6: bar on which the center formed (third member segment's end fractal). */
  established: number;
};
export type CzscRawMovement = {
  type: number;
  firstCenter: number;
  lastCenter: number;
  start: number;
  end: number;
  confirmedAt: number;
  connectionStart: number;
  connectionEnd: number;
  successor: number;
  successorEstablishedAt: number;
  completedAt: number;
  completedByIndex: number;
  completedBy: number;
  /** v5: lesson-89 zhongyin start (bar); end = successorEstablishedAt. -1 = none. */
  zhongyinStart: number;
};
export type CzscRawBreakout = {
  center: number;
  direction: number;
  leavePivot: number;
  retestPivot: number;
  third: number;
  confirmedAt: number;
  divergence: CzscRawDivergence;
};
export type CzscRawSignal = {
  index: number;
  pivot: number;
  /** ±1/±2/±3 */
  type: number;
  center: number;
  movement: number;
  breakout: number;
  basedOn: number;
  stop: number;
  confirmedAt: number;
  revokedAt: number;
  hindsight: number;
  divergence: CzscRawDivergence;
  quality: number;
  context: number;
  secondBasePivot: number;
  secondTurnPivot: number;
  smallTurnBasePivot: number;
  smallTurnLeavePivot: number;
  smallTurnRetestPivot: number;
};
export type CzscRawEvent = { bar: number; op: number; signal: number };
export type CzscRawBar = {
  dif: number;
  dea: number;
  macd: number;
  kiss: number;
  gap: number;
  fractalStrength: number;
  instantDivergence: number;
  /** v6: MA5 / MA20 of close, the pair used for kisses. */
  maShort: number;
  maLong: number;
};
export type CzscRawNode = {
  level: number;
  ordinal: number;
  type: number;
  start: number;
  end: number;
  centerStart: number;
  centerEnd: number;
  centerCount: number;
  established: number;
  connection: number;
  completed: number;
  successor: number;
  firstChild: number;
  childCount: number;
  confirmedAt: number;
  /** level 0: czsc_centers index; level >= 1: recursiveCenters index. */
  firstCenter: number;
  lastCenter: number;
  high: number;
  low: number;
  zhongyinStart: number;
};
/** v5: level >= 1 centers; members are next-lower-level nodes. */
export type CzscRawRecursiveCenter = {
  level: number;
  ordinal: number;
  start: number;
  end: number;
  zg: number;
  zd: number;
  gg: number;
  dd: number;
  direction: number;
  firstMember: number;
  memberCount: number;
  established: number;
  confirmedAt: number;
};
/** v5: level >= 1 same-level connection; members are next-lower-level nodes. */
export type CzscRawConnection = {
  level: number;
  ordinal: number;
  left: number;
  right: number;
  start: number;
  end: number;
  firstMember: number;
  memberCount: number;
  confirmedAt: number;
};
export type CzscRawNested = {
  lowSignal: number;
  highSignal: number;
  highSegmentStart: number;
  highSegmentEnd: number;
  insideHighSegment: number;
  confirmed: number;
  newExtreme: number;
  smallTurn: number;
  highPrevStartLow: number;
  highPrevEndLow: number;
  highCurStartLow: number;
  highCurEndLow: number;
};
export type CzscRawFamily = {
  pivots: CzscRawPivot[];
  centers: CzscRawCenter[];
  movements: CzscRawMovement[];
  breakouts: CzscRawBreakout[];
  signals: CzscRawSignal[];
  events: CzscRawEvent[];
  bars: CzscRawBar[];
  nodes: CzscRawNode[];
  children: number[];
  recursiveCenters: CzscRawRecursiveCenter[];
  connections: CzscRawConnection[];
};
export type CzscSnapshot = {
  hash: string;
  apiVersion: number;
  /** Source git commit baked in at build time ("-dirty" / "unknown" possible). */
  buildCommit: string;
  /** v20 canonical analysis identity (`czsc_config_id`), e.g. "stroke=strict;…". */
  configId: string;
  /**
   * One build, two levels. Slots keep their historical names: "0" = stroke
   * level, "1100" = segment level. Under the default configuration they are
   * byte-identical to the former configs 0 and 1100.
   */
  families: Record<string, CzscRawFamily>;
  /** Interval nesting between the stroke and segment levels of the same build. */
  nested: CzscRawNested[];
};

/** One `czsc_build` call (api v20). */
export type CzscRequest = {
  /** Overrides on the DLL default analysis configuration. */
  config?: Partial<CzscConfig>;
  /** Display-only projection; omitted = DLL default (extended center boxes). */
  projection?: Partial<CzscProjection>;
  /** 0 stroke level, 1 segment level; default both. */
  levels?: (0 | 1)[];
  events?: boolean;
  recursion?: boolean;
  /** Requires both levels. */
  nested?: boolean;
  /** Per-bar table (MACD, MA, kisses…); default true. */
  bars?: boolean;
};

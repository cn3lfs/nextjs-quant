// Mirrors adapter/czsc_api.h (czsc-tdx, api v5). Bar positions are zero-based
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
  index: number;
  kind: number;
  price: number;
  fractalAt: number;
  confirmedAt: number;
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
  families: Record<string, CzscRawFamily>;
  /** low = config 0, high = config 1100 */
  nested: CzscRawNested[];
};

export const CZSC_FLAG_EVENTS = 1;
export const CZSC_FLAG_HIGHER = 2;

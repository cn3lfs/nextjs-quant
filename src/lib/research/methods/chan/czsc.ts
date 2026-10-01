/** Engine identity recorded in every derived version string. */
export const czscSourceCommit = "czsc-api-v4";

/** czsc_signal.context bits (adapter/czsc_api.h). */
export const CZSC_CTX = {
  abc: 0x01,
  zeroPullback: 0x02,
  lineWeak: 0x04,
  standard: 0x08,
  smallTurn: 0x10,
  overlap: 0x20,
  firstRetest: 0x40,
} as const;

export interface CzscPoint {
  index: number;
  date: string;
  direction: number;
  price: number;
  /** Earliest bar after which this endpoint never changes; -1 = not final. */
  confirmedAt?: number;
}
export interface CzscCenter {
  start: number;
  /** Extended end (lessons 18/20) by default; the chart's projection may end the box at the first three members. */
  end: number;
  startDate: string;
  endDate: string;
  direction: number;
  ZG: number;
  ZD: number;
  GG: number;
  DD: number;
  confirmedAt?: number;
  /** Lesson 20 relation to the previous center: 1 up / -1 down / 2 expansion / 0 first. */
  relation?: number;
  /** 0 extension / 1 expansion / 2 newborn up / 3 newborn down / -1 first. */
  lifecycle?: number;
}
export interface CzscFamily {
  /** Level slot: 0 stroke level / 1100 segment level (names kept from the pre-v20 config codes). */
  config: 0 | 1100;
  points: CzscPoint[];
  centers: CzscCenter[];
  signals: {
    index: number;
    date: string;
    kind: number;
    quality: number;
    /** Bar on which the signal became knowable (endpoint confirmed); -1 = not yet. */
    confirmedAt?: number;
    /** Bar on which the live signal was revoked; -1 = still valid. */
    revokedAt?: number;
    /** Native invalidation price (lessons 20/21/27). */
    stop?: number;
    centerId?: number;
    divergence?: {
      areaRatio: number;
      priceRatio: number;
      speedRatio: number;
      flags: number;
      semantic: number;
    };
    containment?: {
      highCandidate: CzscHighCandidate;
      lowStart: number;
      lowEnd: number;
      rule: string;
    };
    structure?: CzscSignalStructure;
  }[];
  native?: CzscNativeProjection;
  diagnostics?: {
    version: typeof czscSourceCommit;
    ma: {
      index: number;
      difference: number;
      kiss: number;
      volumeKiss: number;
      instantWarning: number;
    }[];
    lifecycle: { index: number; value: number }[];
    nested: CzscNestedStructure[];
  };
  // Output 23 describes the movement belonging to each signal, not every bar.
  movements: { index: number; direction: number }[];
  qualities: { index: number; value: number }[];
  divergences: { start: number; end: number; direction: number }[];
}
/** IDs are native one-based object ordinals, NEVER bar indices. Zero denotes
 * absent association. The nested source is a candidate ordinal, not a signal. */
export type CzscSignalStructure = {
  /** CZSC_CTX bit mask (adapter/czsc_api.h), frozen at signal confirmation. */
  contextFlags: number;
  pointId: number;
  trendId: number;
  breakoutId: number;
  leavePointId: number;
  retestPointId: number;
  secondBasePointId: number;
  secondTurnPointId: number;
  smallTurnBasePointId: number;
  smallTurnLeavePointId: number;
  smallTurnRetestPointId: number;
  previousStartPointId: number;
  previousEndPointId: number;
  currentStartPointId: number;
  currentEndPointId: number;
  centerLifecycle: number;
};
export type CzscNestedStructure = {
  lowConfig: 0;
  sourceConfig: 1100;
  index: number;
  level: number;
  sourceCandidateId: number;
  lowStartPointId: number;
  lowEndPointId: number;
  semantic: number;
  confirmFlags: number;
  direction: number;
};
export interface CzscSignalDetails {
  strategyVersion: "czsc-monitor-1";
  dllVersion: string;
  config: 0 | 1100;
  points: {
    key: string;
    date: string;
    kind: number;
    quality: number;
    center: CzscCenter | null;
    divergence: string;
    invalidation: string;
  }[];
}
export interface CzscResult {
  status: "structure" | "no-structure";
  hash: string;
  sourceCommit: typeof czscSourceCommit;
  /** api v20 canonical analysis identity (`czsc_config_id`); readable and comparable. */
  configId?: string;
  families: CzscFamily[];
}

/** Snapshot-local IDs are one-based; bar positions are decoded to zero-based.
 * No completion or theoretical-level inference is hidden in this transport. */
export type CzscNativeTrend = {
  id: number;
  config: 0 | 1100;
  unit: number;
  type: number;
  start: number;
  end: number;
  firstCenterId: number;
  lastCenterId: number;
  memberCenterIds: number[];
  /** Bar at which the successor movement's first center was established; null = open. */
  completedAt: number | null;
  /** Bar of the first-class signal ending this trend on its last center; -1 = none. */
  completedByIndex: number;
  confirmedAt: number;
};
export type CzscHighCandidate = {
  id: number;
  config: 1100;
  index: number;
  kind: number;
  pointId: number;
  segmentStartPointId: number;
  segmentEndPointId: number;
  segmentStart: number | null;
  segmentEnd: number | null;
  semantic: number;
  divergence: boolean;
  trendId: number;
  centerId: number;
  source: number;
  priority: number;
  quality: number;
  unit: 2;
  newExtreme: boolean;
  weakSpace: boolean;
  weakSpeed: boolean;
  weakMacd: boolean;
  currentStart: number | null;
  currentEnd: number | null;
};
export type CzscNativeProjection = {
  version: typeof czscSourceCommit;
  config: 0 | 1100;
  trends: CzscNativeTrend[];
  highCandidates: CzscHighCandidate[];
  completedSequence: "unavailable";
  recursive?: CzscRecursive;
  recursiveMovements?: import("./czsc-movements").CzscMovements;
};

/** Snapshot-local foreign keys; evidence indices are NOT discovery times. */
export type CzscRecursiveNode = {
  id: number;
  level: number;
  start: number;
  end: number;
  centerStart: number;
  centerEnd: number;
  established: number;
  connection: number | null;
  completed: number | null;
  successorId: number;
  children: number[];
  high: number;
  low: number;
  ZG: number;
  ZD: number;
};
export type CzscCompletion = {
  id: number;
  trendId: number;
  space: 0 | 1;
  connectionPointId: number;
  connection: number;
  requiredPointId: number;
  required: number;
  observed: number;
  successorId: number;
  successorEstablished: number | null;
  level: number | null;
};
export type CzscRecursive = {
  anchor: 1 | 2 | 3;
  config: 0 | 1100;
  nodes: CzscRecursiveNode[];
  completions: CzscCompletion[];
  transitions: {
    id: number;
    completionId: number;
    variant: 1 | 2;
    entered: number;
    ended: number | null;
    observed: number;
    contraction: number | null;
    available: boolean;
  }[];
};

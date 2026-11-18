/**
 * P4 confirmation components: F02.01 Dow structure filter, F02.02 trend
 * hierarchy and F02.03 intermarket confirmation.
 *
 * All points are caller-confirmed pivots. This module never computes pivots
 * and never consumes an endpoint whose confirmation time is after `asOf`.
 */

/** Epoch milliseconds or a strict ISO timestamp that carries a timezone. */
export type ConfirmationTime = number | string;

export type SwingTrend = "UP" | "DOWN" | "RANGE" | "UNKNOWN";

export type ConfirmedSwingPoint = {
  kind: "high" | "low";
  price: number;
  confirmedAt: ConfirmationTime;
};

export type ConfirmedSwingInput = {
  /** Exactly the two latest confirmed highs, in any order. */
  highs: readonly ConfirmedSwingPoint[];
  /** Exactly the two latest confirmed lows, in any order. */
  lows: readonly ConfirmedSwingPoint[];
  asOf: ConfirmationTime;
};

export type TrendHierarchyInput = {
  asOf: ConfirmationTime;
  major?: Omit<ConfirmedSwingInput, "asOf">;
  medium?: Omit<ConfirmedSwingInput, "asOf">;
  minor?: Omit<ConfirmedSwingInput, "asOf">;
};

export type TrendHierarchy = {
  major: SwingTrend;
  medium: SwingTrend;
  minor: SwingTrend;
  /** Long-term UP with a medium-term DOWN; never an entry by itself. */
  pullbackCandidate: boolean;
};

const strictIso =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** Numeric epoch values are compared numerically, never as text. */
export function confirmationEpoch(value: ConfirmationTime | null | undefined) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = strictIso.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const zone = match[8]!;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59)
    return null;
  if (second > 59) return null;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  // Date.parse normalizes some impossible calendar dates; reject them first.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return null;

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

type OrderedPoint = { price: number; time: number };

function twoConfirmedPoints(
  points: readonly ConfirmedSwingPoint[] | null | undefined,
  kind: ConfirmedSwingPoint["kind"],
  asOf: number,
): [OrderedPoint, OrderedPoint] | null {
  if (!Array.isArray(points) || points.length !== 2) return null;
  const parsed: OrderedPoint[] = [];
  for (const point of points) {
    if (!point || point.kind !== kind) return null;
    const time = confirmationEpoch(point.confirmedAt);
    if (
      time === null ||
      time > asOf ||
      !Number.isFinite(point.price) ||
      point.price <= 0
    )
      return null;
    parsed.push({ price: point.price, time });
  }
  // Equal confirmation times cannot establish pivot order. Return UNKNOWN
  // conservatively; never sort by price to guess which swing came first.
  const first = parsed[0];
  const second = parsed[1];
  if (!first || !second || first.time === second.time) return null;
  return first.time < second.time ? [first, second] : [second, first];
}

/**
 * F02.01 P1-P3: the two latest confirmed highs and lows on one index.
 * UP = H2>H1 and L2>L1; DOWN = H2<H1 and L2<L1; otherwise RANGE.
 */
export function confirmedSwingTrend(
  input: ConfirmedSwingInput | null | undefined,
): SwingTrend {
  const asOf = confirmationEpoch(input?.asOf);
  if (asOf === null) return "UNKNOWN";
  const highs = twoConfirmedPoints(input?.highs, "high", asOf);
  const lows = twoConfirmedPoints(input?.lows, "low", asOf);
  if (!highs || !lows) return "UNKNOWN";
  const [h1, h2] = highs;
  const [l1, l2] = lows;
  if (h2.price > h1.price && l2.price > l1.price) return "UP";
  if (h2.price < h1.price && l2.price < l1.price) return "DOWN";
  return "RANGE";
}

export type DowPairIndexInput = Omit<ConfirmedSwingInput, "asOf"> & {
  /** Optional per-index clock; must equal the shared evaluation time. */
  asOf?: ConfirmationTime;
};

export type DowPairInput = {
  /** One clock for both indices. */
  asOf: ConfirmationTime;
  indices: readonly [DowPairIndexInput, DowPairIndexInput];
};

/**
 * F02.01 P4-P6: both pre-selected indices must carry the same structure under
 * one common evaluation clock. One confirming index never implies the other.
 */
export function confirmDowPair(
  input: DowPairInput | null | undefined,
): "UP" | "DOWN" | "WAIT" | "UNKNOWN" {
  const asOf = confirmationEpoch(input?.asOf);
  const indices = input?.indices;
  if (
    !input ||
    asOf === null ||
    !Array.isArray(indices) ||
    indices.length !== 2
  )
    return "UNKNOWN";
  const states: SwingTrend[] = [];
  for (const index of indices) {
    if (!index) return "UNKNOWN";
    if (index.asOf !== undefined) {
      const own = confirmationEpoch(index.asOf);
      if (own === null || own !== asOf) return "UNKNOWN";
    }
    states.push(
      confirmedSwingTrend({
        asOf: input.asOf,
        highs: index.highs,
        lows: index.lows,
      }),
    );
  }
  const first = states[0];
  const second = states[1];
  if (!first || !second) return "UNKNOWN";
  if (first === "UNKNOWN" || second === "UNKNOWN") return "UNKNOWN";
  if (first === "UP" && second === "UP") return "UP";
  if (first === "DOWN" && second === "DOWN") return "DOWN";
  return "WAIT";
}

function hierarchyLayer(
  layer: Omit<ConfirmedSwingInput, "asOf"> | undefined,
  asOf: number,
): SwingTrend {
  if (!layer) return "UNKNOWN";
  return confirmedSwingTrend({ asOf, highs: layer.highs, lows: layer.lows });
}

/**
 * F02.02: each fixed frequency keeps its own state. A shorter timeframe never
 * rewrites a longer one; long UP + medium DOWN is only a pullback candidate.
 */
export function trendHierarchy(
  input: TrendHierarchyInput | null | undefined,
): TrendHierarchy {
  const asOf = confirmationEpoch(input?.asOf);
  if (asOf === null)
    return {
      major: "UNKNOWN",
      medium: "UNKNOWN",
      minor: "UNKNOWN",
      pullbackCandidate: false,
    };
  const major = hierarchyLayer(input?.major, asOf);
  const medium = hierarchyLayer(input?.medium, asOf);
  const minor = hierarchyLayer(input?.minor, asOf);
  return {
    major,
    medium,
    minor,
    pullbackCandidate: major === "UP" && medium === "DOWN",
  };
}

export type IndexConfirmationStatus = "WAIT" | "CONFIRMED" | "UNKNOWN";

export type IndexConfirmationCandidate = {
  time: number;
  barIndex: number;
  boundary: number;
};

export type IndexConfirmationState = {
  readonly version: number | null;
  readonly boundary: readonly [number, number] | null;
  readonly frozenAt: number | null;
  readonly boundaryValid: boolean;
  readonly invalidatedVersion: number | null;
  readonly candidates: readonly [
    IndexConfirmationCandidate | null,
    IndexConfirmationCandidate | null,
  ];
  /** Monotonic watermark of valid-time observations. */
  readonly lastBarIndex: number | null;
  readonly lastTime: number | null;
  /** Last observation with two complete closes; adjacency only uses this. */
  readonly continuityBarIndex: number | null;
};

export type FrozenBoundaryPair = {
  version: number;
  /** Whitelisted before any candidate observation on this version. */
  frozenAt: ConfirmationTime;
  values: readonly [number, number];
};

export type IndexConfirmationInput = {
  state: IndexConfirmationState;
  boundary: FrozenBoundaryPair;
  /** Candidate lifetime and pair spacing in completed bars. */
  window: number;
  barIndex: number;
  time: ConfirmationTime;
  previousCloses: readonly [number | null, number | null];
  currentCloses: readonly [number | null, number | null];
  /** Proven prior completed bar; supply together with previousTime or omit both. */
  previousBarIndex?: number | null;
  previousTime?: ConfirmationTime | null;
};

export type IndexConfirmationResult = {
  readonly status: IndexConfirmationStatus;
  readonly state: IndexConfirmationState;
};

export const initialIndexConfirmationState: IndexConfirmationState =
  Object.freeze({
    version: null,
    boundary: null,
    frozenAt: null,
    boundaryValid: false,
    invalidatedVersion: null,
    candidates: Object.freeze([null, null] as [null, null]),
    lastBarIndex: null,
    lastTime: null,
    continuityBarIndex: null,
  });

function freezeConfirmationState(
  state: IndexConfirmationState,
): IndexConfirmationState {
  const [first, second] = state.candidates;
  return Object.freeze({
    ...state,
    boundary: state.boundary
      ? Object.freeze([state.boundary[0], state.boundary[1]] as [
          number,
          number,
        ])
      : null,
    candidates: Object.freeze([
      first ? Object.freeze({ ...first }) : null,
      second ? Object.freeze({ ...second }) : null,
    ] as [
      IndexConfirmationCandidate | null,
      IndexConfirmationCandidate | null,
    ]),
  });
}

/** Invalid observations retain every verifiable watermark and version fact. */
function unknownConfirmation(
  state: IndexConfirmationState | null | undefined,
): IndexConfirmationResult {
  return Object.freeze({
    status: "UNKNOWN" as const,
    state: freezeConfirmationState(state ?? initialIndexConfirmationState),
  });
}

function completeCloses(
  closes: readonly (number | null)[] | null | undefined,
): closes is readonly [number, number] {
  return (
    Array.isArray(closes) &&
    closes.length === 2 &&
    closes.every(
      (close) =>
        typeof close === "number" && Number.isFinite(close) && close > 0,
    )
  );
}

/**
 * F02.03 pure state transition. `window` counts completed bars, not elapsed
 * milliseconds. Expiry is checked before gap clearing and burns the whole
 * version. A valid-time missing bar updates the watermark but only breaks
 * continuity. Invalid, duplicate or backward observations return UNKNOWN
 * without erasing verifiable state. frozenAt must never exceed observation time.
 */
export function advanceIndexConfirmation(
  input: IndexConfirmationInput | null | undefined,
): IndexConfirmationResult {
  const state = input?.state;
  if (!input || !state) return unknownConfirmation(state);

  const time = confirmationEpoch(input.time);
  const frozenAt = confirmationEpoch(input.boundary.frozenAt);
  const values = input.boundary.values;
  const previousCloses = input.previousCloses;
  const currentCloses = input.currentCloses;
  if (
    time === null ||
    frozenAt === null ||
    frozenAt > time ||
    !Number.isSafeInteger(input.boundary.version) ||
    input.boundary.version < 0 ||
    !Array.isArray(values) ||
    values.length !== 2 ||
    !values.every((value) => Number.isFinite(value) && value > 0) ||
    !Number.isSafeInteger(input.window) ||
    input.window <= 0 ||
    !Number.isSafeInteger(input.barIndex) ||
    input.barIndex < 0 ||
    !Array.isArray(previousCloses) ||
    previousCloses.length !== 2 ||
    !Array.isArray(currentCloses) ||
    currentCloses.length !== 2
  )
    return unknownConfirmation(state);

  // Optional caller-proven prior bar. Both fields must be present; it can arm
  // the first or a new boundary version only when it is strictly earlier.
  let declaredPrevious = false;
  let provenBarIndex = -1;
  let provenTime = 0;
  if (input.previousBarIndex != null || input.previousTime != null) {
    const parsedPreviousTime = confirmationEpoch(input.previousTime);
    if (
      input.previousBarIndex == null ||
      input.previousTime == null ||
      !Number.isSafeInteger(input.previousBarIndex) ||
      input.previousBarIndex < 0 ||
      parsedPreviousTime === null
    )
      return unknownConfirmation(state);
    if (
      input.previousBarIndex + 1 !== input.barIndex ||
      parsedPreviousTime >= time
    )
      return unknownConfirmation(state);
    if (frozenAt > parsedPreviousTime) return unknownConfirmation(state);
    declaredPrevious = true;
    provenBarIndex = input.previousBarIndex;
    provenTime = parsedPreviousTime;
  }

  if (state.lastTime !== null && time <= state.lastTime)
    return unknownConfirmation(state);
  if (state.lastBarIndex !== null && input.barIndex <= state.lastBarIndex)
    return unknownConfirmation(state);

  const version = input.boundary.version;
  const window = input.window;
  const barIndex = input.barIndex;
  const valuesPair = Object.freeze([values[0], values[1]] as [number, number]);

  if (state.version !== null && version < state.version)
    return unknownConfirmation(state);
  const sameVersion = state.version === version;
  if (
    sameVersion &&
    (!state.boundary ||
      state.boundary[0] !== valuesPair[0] ||
      state.boundary[1] !== valuesPair[1] ||
      state.frozenAt !== frozenAt)
  )
    return unknownConfirmation(state);

  const isNewVersion = !sameVersion;
  const boundaryValid = isNewVersion ? true : state.boundaryValid;
  const invalidatedVersion = isNewVersion ? null : state.invalidatedVersion;
  let candidates: [
    IndexConfirmationCandidate | null,
    IndexConfirmationCandidate | null,
  ] = isNewVersion ? [null, null] : [state.candidates[0], state.candidates[1]];

  // F02.03 P2: expiry comes before gap/missing clearing and burns the version.
  if (
    candidates.some(
      (candidate) =>
        candidate !== null && barIndex - candidate.barIndex > window,
    )
  ) {
    return Object.freeze({
      status: "WAIT" as const,
      state: freezeConfirmationState({
        version,
        boundary: valuesPair,
        frozenAt,
        boundaryValid: false,
        invalidatedVersion: version,
        candidates: [null, null],
        lastBarIndex: barIndex,
        lastTime: time,
        continuityBarIndex: null,
      }),
    });
  }

  if (!completeCloses(currentCloses)) {
    return Object.freeze({
      status: "UNKNOWN" as const,
      state: freezeConfirmationState({
        version,
        boundary: valuesPair,
        frozenAt,
        boundaryValid,
        invalidatedVersion,
        candidates: [null, null],
        lastBarIndex: barIndex,
        lastTime: time,
        continuityBarIndex: null,
      }),
    });
  }
  if (!completeCloses(previousCloses)) {
    // The current bar is known even though its predecessor is not. Seed the
    // current continuity so the next full adjacent observation can cross.
    return Object.freeze({
      status: "UNKNOWN" as const,
      state: freezeConfirmationState({
        version,
        boundary: valuesPair,
        frozenAt,
        boundaryValid,
        invalidatedVersion,
        candidates: [null, null],
        lastBarIndex: barIndex,
        lastTime: time,
        continuityBarIndex: barIndex,
      }),
    });
  }

  let provenanceUsable = false;
  if (declaredPrevious) {
    // A new version starts from first-call rules: a proven adjacent pair arms
    // immediately even if the previous version had stopped observing.
    if (isNewVersion) provenanceUsable = true;
    else if (state.lastBarIndex === null) provenanceUsable = true;
    else if (provenBarIndex === state.lastBarIndex) {
      if (provenTime !== state.lastTime) return unknownConfirmation(state);
      provenanceUsable = state.continuityBarIndex === state.lastBarIndex;
    }
    if (!provenanceUsable) candidates = [null, null];
  }

  let adjacent = false;
  if (provenanceUsable) adjacent = true;
  else if (
    !isNewVersion &&
    state.continuityBarIndex !== null &&
    barIndex === state.continuityBarIndex + 1
  )
    adjacent = true;
  if (
    !isNewVersion &&
    state.lastBarIndex !== null &&
    barIndex > state.lastBarIndex + 1
  )
    candidates = [null, null]; // skipped bar: clear candidates, then seed only

  if (invalidatedVersion !== null && invalidatedVersion === version) {
    return Object.freeze({
      status: "WAIT" as const,
      state: freezeConfirmationState({
        version,
        boundary: valuesPair,
        frozenAt,
        boundaryValid: false,
        invalidatedVersion,
        candidates: [null, null],
        lastBarIndex: barIndex,
        lastTime: time,
        continuityBarIndex: barIndex,
      }),
    });
  }

  for (const i of [0, 1] as const) {
    const candidate = candidates[i];
    if (candidate && currentCloses[i] <= valuesPair[i]) candidates[i] = null;
  }

  if (adjacent) {
    for (const i of [0, 1] as const) {
      if (
        candidates[i] === null &&
        previousCloses[i] <= valuesPair[i] &&
        currentCloses[i] > valuesPair[i]
      )
        candidates[i] = {
          time,
          barIndex,
          boundary: valuesPair[i],
        };
    }
  }

  const confirmed =
    boundaryValid &&
    candidates[0] !== null &&
    candidates[1] !== null &&
    Math.abs(candidates[0].barIndex - candidates[1].barIndex) <= window;

  return Object.freeze({
    status: confirmed ? ("CONFIRMED" as const) : ("WAIT" as const),
    state: freezeConfirmationState({
      version,
      boundary: valuesPair,
      frozenAt,
      boundaryValid,
      invalidatedVersion,
      candidates,
      lastBarIndex: barIndex,
      lastTime: time,
      continuityBarIndex: barIndex,
    }),
  });
}

export type PointAndFigureColumn = {
  kind: "X" | "O";
  startIndex: number;
  endIndex: number;
  /** Integer box coordinates, inclusive. */
  bottom: number;
  top: number;
};

export type PointAndFigureSignal = {
  kind: "BUY_SIGNAL" | "SELL_SIGNAL";
  columnIndex: number;
  barIndex: number;
  /** Preceding same-kind column extreme that was crossed. */
  boundary: number;
};

export type PointAndFigureStatus =
  "WAIT" | "FILTER" | "BUY_SIGNAL" | "SELL_SIGNAL" | "UNKNOWN";

export type PointAndFigureInput = {
  /** Completed closes; null (or invalid) marks a missing observation. */
  closes: readonly (number | null)[];
  /** Fixed box size b > 0. */
  boxSize: number;
  /** Integer reversal boxes r >= 1. */
  reversal: number;
};

export type PointAndFigureResult = {
  readonly status: PointAndFigureStatus;
  readonly columns: readonly PointAndFigureColumn[];
  readonly signals: readonly PointAndFigureSignal[];
  /** Indices where a missing close reset the chart segment. */
  readonly resets: readonly number[];
  readonly boxSize: number;
  readonly reversal: number;
};

function previousSameKind(
  columns: readonly PointAndFigureColumn[],
  segmentStart: number,
  kind: PointAndFigureColumn["kind"],
  beforeIndex = columns.length,
) {
  for (let index = beforeIndex - 1; index >= segmentStart; index--) {
    const column = columns[index];
    if (column && column.kind === kind) return column;
  }
  return null;
}

/**
 * F05.13 fixed-box close-only P&F. Coordinates are floor(close / b); a null or
 * invalid close resets the segment so no column or breakout is inferred across
 * a missing observation. Changing b or r starts a different research version.
 */
export function pointAndFigure(
  input: PointAndFigureInput | null | undefined,
): PointAndFigureResult {
  const boxSize = input?.boxSize;
  const reversal = input?.reversal;
  const closes = input?.closes;
  if (
    !input ||
    !Array.isArray(closes) ||
    typeof boxSize !== "number" ||
    !Number.isFinite(boxSize) ||
    boxSize <= 0 ||
    typeof reversal !== "number" ||
    !Number.isSafeInteger(reversal) ||
    reversal < 1 ||
    closes.length === 0
  )
    return Object.freeze({
      status: "UNKNOWN" as const,
      columns: Object.freeze([]),
      signals: Object.freeze([]),
      resets: Object.freeze([]),
      boxSize: typeof boxSize === "number" ? boxSize : 0,
      reversal: typeof reversal === "number" ? reversal : 0,
    });

  const columns: PointAndFigureColumn[] = [];
  const signals: PointAndFigureSignal[] = [];
  const resets: number[] = [];
  let direction: "X" | "O" | null = null;
  let anchor: number | null = null;
  let activeIndex = -1;
  let segmentStart = 0;
  let signalEmitted = false;
  let lastEvent: "BUY_SIGNAL" | "SELL_SIGNAL" | null = null;
  let lastMissing = false;

  const emit = (
    kind: PointAndFigureSignal["kind"],
    boundary: number,
    index: number,
  ) => {
    signals.push({ kind, columnIndex: activeIndex, barIndex: index, boundary });
    signalEmitted = true;
    lastEvent = kind;
  };

  for (let index = 0; index < closes.length; index++) {
    lastEvent = null;
    const close = closes[index];
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) {
      direction = null;
      anchor = null;
      activeIndex = -1;
      segmentStart = columns.length;
      signalEmitted = false;
      resets.push(index);
      lastMissing = true;
      continue;
    }
    lastMissing = false;
    const z = Math.floor(close / boxSize);
    if (!Number.isSafeInteger(z)) {
      direction = null;
      anchor = null;
      activeIndex = -1;
      segmentStart = columns.length;
      signalEmitted = false;
      resets.push(index);
      lastMissing = true;
      continue;
    }

    if (direction === null) {
      if (anchor === null) {
        anchor = z;
        continue;
      }
      if (z === anchor) continue;
      const kind = z > anchor ? "X" : "O";
      const column: PointAndFigureColumn = {
        kind,
        startIndex: index,
        endIndex: index,
        bottom: kind === "X" ? anchor + 1 : z,
        top: kind === "X" ? z : anchor - 1,
      };
      const previous = previousSameKind(columns, segmentStart, kind);
      activeIndex = columns.length;
      columns.push(column);
      direction = kind;
      signalEmitted = false;
      if (previous) {
        if (kind === "X" && column.top > previous.top)
          emit("BUY_SIGNAL", previous.top, index);
        if (kind === "O" && column.bottom < previous.bottom)
          emit("SELL_SIGNAL", previous.bottom, index);
      }
      continue;
    }

    const column = columns[activeIndex]!;
    if (direction === "X") {
      if (z > column.top) {
        column.top = z;
        column.endIndex = index;
        if (!signalEmitted) {
          const previous = previousSameKind(
            columns,
            segmentStart,
            "X",
            activeIndex,
          );
          if (previous && column.top > previous.top)
            emit("BUY_SIGNAL", previous.top, index);
        }
      } else if (z <= column.top - reversal) {
        const previous = previousSameKind(columns, segmentStart, "O");
        const next: PointAndFigureColumn = {
          kind: "O",
          startIndex: index,
          endIndex: index,
          bottom: z,
          top: column.top - 1,
        };
        activeIndex = columns.length;
        columns.push(next);
        direction = "O";
        signalEmitted = false;
        if (previous && next.bottom < previous.bottom)
          emit("SELL_SIGNAL", previous.bottom, index);
      }
    } else {
      if (z < column.bottom) {
        column.bottom = z;
        column.endIndex = index;
        if (!signalEmitted) {
          const previous = previousSameKind(
            columns,
            segmentStart,
            "O",
            activeIndex,
          );
          if (previous && column.bottom < previous.bottom)
            emit("SELL_SIGNAL", previous.bottom, index);
        }
      } else if (z >= column.bottom + reversal) {
        const previous = previousSameKind(columns, segmentStart, "X");
        const next: PointAndFigureColumn = {
          kind: "X",
          startIndex: index,
          endIndex: index,
          bottom: column.bottom + 1,
          top: z,
        };
        activeIndex = columns.length;
        columns.push(next);
        direction = "X";
        signalEmitted = false;
        if (previous && next.top > previous.top)
          emit("BUY_SIGNAL", previous.top, index);
      }
    }
  }

  const sameKindCounts = { X: 0, O: 0 };
  for (let index = segmentStart; index < columns.length; index++) {
    const column = columns[index];
    if (column) sameKindCounts[column.kind]++;
  }
  const status: PointAndFigureStatus = lastMissing
    ? "UNKNOWN"
    : lastEvent
      ? lastEvent
      : sameKindCounts.X >= 2 || sameKindCounts.O >= 2
        ? "WAIT"
        : "FILTER";

  return Object.freeze({
    status,
    columns: Object.freeze(
      columns.map((column) => Object.freeze({ ...column })),
    ),
    signals: Object.freeze(
      signals.map((signal) => Object.freeze({ ...signal })),
    ),
    resets: Object.freeze([...resets]),
    boxSize,
    reversal,
  });
}

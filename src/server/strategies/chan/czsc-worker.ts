import koffi from "koffi";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { czscInput, type CzscInput } from "./czsc-input";
import type { CzscConfigOption } from "../../../lib/chart/czsc-settings";
import type { CzscRawFamily, CzscSnapshot } from "./czsc-api";

// adapter/czsc_api.h (czsc-tdx) is the single contract; every struct is packed
// 4-byte fields with a leading size, so koffi's natural layout matches exactly.
export const czscApiVersion = 8;
const dllPath = resolve("runtime/czsc/CZSC64.dll");
const hash = createHash("sha256").update(readFileSync(dllPath)).digest("hex");
const library = koffi.load(dllPath);

const divergence = koffi.struct("czsc_divergence", {
  size: "uint32",
  prevStart: "int32",
  prevEnd: "int32",
  curStart: "int32",
  curEnd: "int32",
  prevSpace: "float",
  prevSpeed: "float",
  prevArea: "float",
  curSpace: "float",
  curSpeed: "float",
  curArea: "float",
  newExtreme: "int32",
  weakSpace: "int32",
  weakSpeed: "int32",
  weakArea: "int32",
  holds: "int32",
  semantic: "int32",
});
const structs = {
  pivot: koffi.struct("czsc_pivot", {
    size: "uint32",
    index: "int32",
    kind: "int32",
    price: "float",
    fractalAt: "int32",
    confirmedAt: "int32",
    extremeIndex: "int32",
  }),
  center: koffi.struct("czsc_center", {
    size: "uint32",
    start: "int32",
    end: "int32",
    firstPivot: "int32",
    lastPivot: "int32",
    zg: "float",
    zd: "float",
    gg: "float",
    dd: "float",
    direction: "int32",
    confirmedAt: "int32",
    relationToPrev: "int32",
    lifecycle: "int32",
    established: "int32",
  }),
  movement: koffi.struct("czsc_movement", {
    size: "uint32",
    type: "int32",
    firstCenter: "int32",
    lastCenter: "int32",
    start: "int32",
    end: "int32",
    confirmedAt: "int32",
    connectionStart: "int32",
    connectionEnd: "int32",
    successor: "int32",
    successorEstablishedAt: "int32",
    completedAt: "int32",
    completedByIndex: "int32",
    completedBy: "int32",
    zhongyinStart: "int32",
  }),
  breakout: koffi.struct("czsc_breakout", {
    size: "uint32",
    center: "int32",
    direction: "int32",
    leavePivot: "int32",
    retestPivot: "int32",
    third: "int32",
    confirmedAt: "int32",
    divergence,
  }),
  signal: koffi.struct("czsc_signal", {
    size: "uint32",
    index: "int32",
    pivot: "int32",
    type: "int32",
    center: "int32",
    movement: "int32",
    breakout: "int32",
    basedOn: "int32",
    stop: "float",
    confirmedAt: "int32",
    revokedAt: "int32",
    hindsight: "int32",
    divergence,
    quality: "int32",
    context: "uint32",
    secondBasePivot: "int32",
    secondTurnPivot: "int32",
    smallTurnBasePivot: "int32",
    smallTurnLeavePivot: "int32",
    smallTurnRetestPivot: "int32",
  }),
  event: koffi.struct("czsc_event", {
    size: "uint32",
    bar: "int32",
    op: "int32",
    signal: "int32",
  }),
  bar: koffi.struct("czsc_bar", {
    size: "uint32",
    dif: "float",
    dea: "float",
    macd: "float",
    kiss: "int32",
    gap: "int32",
    fractalStrength: "int32",
    instantDivergence: "int32",
    maShort: "float",
    maLong: "float",
  }),
  node: koffi.struct("czsc_recursive_node", {
    size: "uint32",
    level: "int32",
    ordinal: "int32",
    type: "int32",
    start: "int32",
    end: "int32",
    centerStart: "int32",
    centerEnd: "int32",
    centerCount: "int32",
    established: "int32",
    connection: "int32",
    completed: "int32",
    successor: "int32",
    firstChild: "int32",
    childCount: "int32",
    confirmedAt: "int32",
    firstCenter: "int32",
    lastCenter: "int32",
    high: "float",
    low: "float",
    zhongyinStart: "int32",
  }),
  recursiveCenter: koffi.struct("czsc_recursive_center", {
    size: "uint32",
    level: "int32",
    ordinal: "int32",
    start: "int32",
    end: "int32",
    zg: "float",
    zd: "float",
    gg: "float",
    dd: "float",
    direction: "int32",
    firstMember: "int32",
    memberCount: "int32",
    established: "int32",
    confirmedAt: "int32",
  }),
  connection: koffi.struct("czsc_recursive_connection", {
    size: "uint32",
    level: "int32",
    ordinal: "int32",
    left: "int32",
    right: "int32",
    start: "int32",
    end: "int32",
    firstMember: "int32",
    memberCount: "int32",
    confirmedAt: "int32",
  }),
  nested: koffi.struct("czsc_nested", {
    size: "uint32",
    lowSignal: "int32",
    highSignal: "int32",
    highSegmentStart: "int32",
    highSegmentEnd: "int32",
    insideHighSegment: "int32",
    confirmed: "int32",
    newExtreme: "int32",
    smallTurn: "int32",
    highPrevStartLow: "int32",
    highPrevEndLow: "int32",
    highCurStartLow: "int32",
    highCurEndLow: "int32",
  }),
};
const input = koffi.struct("czsc_input", {
  size: "uint32",
  n: "int32",
  high: "float *",
  low: "float *",
  close: "float *",
  volume: "float *",
  config: "int32",
  flags: "int32",
});
// v7 config self-description; packed, size 116 on both pointer widths.
const option = koffi.pack("czsc_config_option", {
  size: "uint32",
  place: "int32",
  value: "int32",
  isDefault: "int32",
  original: "int32",
  key: koffi.array("char", 32, "String"),
  label: koffi.array("char", 32, "String"),
  lessons: koffi.array("char", 32, "String"),
});
const api = {
  valid: library.func("int32_t czsc_config_valid(int32_t config)"),
  options: library.func(
    "int32_t czsc_config_options(_Out_ czsc_config_option *out, int32_t capacity)",
  ),
  version: library.func("int32_t czsc_api_version(void)"),
  error: library.func("const char *czsc_last_error(void)"),
  build: library.func("void *czsc_snapshot_build(const czsc_input *input)"),
  free: library.func("void czsc_snapshot_free(void *snapshot)"),
  nested: library.func("void *czsc_nested_build(void *low, void *high)"),
  commit: library.func("const char *czsc_build_commit(void)"),
};
const table = (name: string) =>
  library.func(`const void *${name}(void *snapshot, _Out_ int32_t *count)`);
const tables = {
  pivots: [table("czsc_pivots"), structs.pivot],
  centers: [table("czsc_centers"), structs.center],
  movements: [table("czsc_movements"), structs.movement],
  breakouts: [table("czsc_breakouts"), structs.breakout],
  signals: [table("czsc_signals"), structs.signal],
  events: [table("czsc_events"), structs.event],
  bars: [table("czsc_bars"), structs.bar],
  nodes: [table("czsc_recursive_nodes"), structs.node],
  children: [table("czsc_recursive_children"), "int32"],
  recursiveCenters: [table("czsc_recursive_centers"), structs.recursiveCenter],
  connections: [table("czsc_recursive_connections"), structs.connection],
} as const;
const nestedRows = table("czsc_nested_rows");

const version = api.version() as number;
if (version < czscApiVersion)
  throw new Error(`CZSC API v${version} < required v${czscApiVersion}`);
const buildCommit = (api.commit() as string | null) ?? "unknown";

function read(
  fn: (handle: unknown, count: number[]) => unknown,
  type: unknown,
  handle: unknown,
) {
  const count = [0];
  const pointer = fn(handle, count);
  const n = count[0]!;
  if (!Number.isInteger(n) || n < 0) throw new Error("CZSC table count");
  if (!n || !pointer) return [];
  const rows = Array.from(
    koffi.decode(pointer, koffi.array(type as never, n)) as ArrayLike<unknown>,
  );
  // Contract: size == sizeof(struct); reject a DLL whose layout drifted.
  if (typeof rows[0] === "object" && rows[0] !== null) {
    const expected = koffi.sizeof(type as never);
    if (rows.some((r) => (r as { size: number }).size !== expected))
      throw new Error("CZSC struct size mismatch");
    for (const r of rows) {
      delete (r as { size?: number }).size;
      const d = (r as { divergence?: { size?: number } }).divergence;
      if (d) {
        if (d.size !== koffi.sizeof(divergence))
          throw new Error("CZSC struct size mismatch");
        delete d.size;
      }
    }
  }
  return rows;
}

function configOptions(): CzscConfigOption[] {
  const n = api.options(null, 0) as number;
  if (n <= 0) return [];
  const out = Array.from({ length: n }, () => ({}));
  const written = api.options(out, n) as number;
  return (out.slice(0, written) as (CzscConfigOption & { size: number })[]).map(
    ({ size, ...row }) => {
      if (size !== koffi.sizeof(option))
        throw new Error("CZSC struct size mismatch");
      return row;
    },
  );
}

const failure = (what: string) =>
  new Error(`${what}: ${(api.error() as string | null) ?? "unknown"}`);

// Synchronous IPC handler; handles never outlive one message.
process.on(
  "message",
  (message: {
    id: number;
    /** Return the v7 config option table instead of building. */
    options?: boolean;
    input: CzscInput;
    configs: number[];
    flags: number;
    nested: boolean;
    /** Per-bar table (MACD, MA, kisses…); omitted when false. */
    bars?: boolean;
  }) => {
    const handles: unknown[] = [];
    try {
      if (message.options) {
        process.send?.({ id: message.id, result: configOptions() });
        return;
      }
      const { high, low, close, volume } = czscInput(message.input);
      const n = high.length;
      if (n > 16777216)
        throw new RangeError("CZSC input exceeds exact index domain");
      if (!Number.isInteger(message.flags) || message.flags & ~3)
        throw new RangeError("Invalid CZSC flags");
      const families: Record<string, CzscRawFamily> = {};
      const byConfig = new Map<number, unknown>();
      for (const config of message.configs) {
        if (!Number.isInteger(config) || api.valid(config) !== 1)
          throw new RangeError(`Unsupported CZSC config ${config}`);
        const handle = api.build({
          size: koffi.sizeof(input),
          n,
          high,
          low,
          close,
          volume,
          config,
          flags: message.flags,
        });
        if (!handle) throw failure("CZSC build failed");
        handles.push(handle);
        byConfig.set(config, handle);
        // Decode and ship only what the caller uses: the per-bar table is a
        // row per bar of full history, and recursion/event tables are empty
        // unless their flags are set. Monitoring and the full-market ledger
        // call once per security, so this dominates IPC volume.
        const wanted = (key: string) =>
          key === "bars"
            ? message.bars !== false
            : key === "events"
              ? (message.flags & 1) !== 0
              : [
                    "nodes",
                    "children",
                    "recursiveCenters",
                    "connections",
                  ].includes(key)
                ? (message.flags & 2) !== 0
                : true;
        families[config] = Object.fromEntries(
          Object.entries(tables).map(([key, [fn, type]]) => [
            key,
            wanted(key) ? read(fn as never, type, handle) : [],
          ]),
        ) as unknown as CzscRawFamily;
      }
      let nested: CzscSnapshot["nested"] = [];
      if (message.nested) {
        const low = byConfig.get(0),
          high = byConfig.get(1100);
        if (!low || !high) throw new Error("区间套需要 0 与 1100 两个快照");
        const handle = api.nested(low, high);
        if (!handle) throw failure("CZSC nested failed");
        handles.push(handle);
        nested = read(
          nestedRows as never,
          structs.nested,
          handle,
        ) as CzscSnapshot["nested"];
      }
      const result: CzscSnapshot = {
        hash,
        apiVersion: version,
        buildCommit,
        families,
        nested,
      };
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      for (const handle of handles) api.free(handle);
    }
  },
);
// Keep the library reachable for the worker lifetime (koffi/doc/load.md).
process.on("disconnect", () => {
  library.unload();
  process.exit(0);
});

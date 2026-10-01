import koffi from "koffi";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { czscInput, type CzscInput } from "./czsc-input";
import type {
  CzscConfig,
  CzscConfigSchema,
  CzscProjection,
} from "../../../lib/chart/czsc-settings";
import type { CzscRawFamily, CzscRequest, CzscSnapshot } from "./czsc-api";

// adapter/czsc_api.h (czsc-tdx) is the single contract; every struct is packed
// 4-byte fields with a leading size, so koffi's natural layout matches exactly.
export const czscApiVersion = 20;
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
// v20: input carries only the series; configuration is a separate struct.
const input = koffi.struct("czsc_input", {
  size: "uint32",
  n: "int32",
  high: "float *",
  low: "float *",
  close: "float *",
  volume: "float *",
});
const config = koffi.struct("czsc_config", {
  size: "uint32",
  strokeRule: "int32",
  strokeEndpoint: "int32",
  strokeGap: "int32",
  gapThreshold: "float",
  segmentMethod: "int32",
  centerStrokeFormation: "int32",
  signalsPublication: "int32",
});
const projection = koffi.struct("czsc_projection", {
  size: "uint32",
  segmentBoundary: "int32",
  centerBox: "int32",
});
// Schema rows are packed(1) with fixed UTF-8 char arrays.
const text = (n: number) => koffi.array("char", n, "String");
const schemaRows = {
  fields: koffi.pack("czsc_config_field", {
    size: "uint32",
    key: text(32),
    label: text(32),
    layer: "int32",
    kind: "int32",
    defaultValue: "int32",
    defaultFloat: "float",
    minFloat: "float",
    maxFloat: "float",
  }),
  choices: koffi.pack("czsc_config_choice", {
    size: "uint32",
    field: text(32),
    value: "int32",
    key: text(32),
    label: text(32),
    lessons: text(32),
    original: "int32",
    note: text(256),
  }),
  rules: koffi.pack("czsc_config_rule", {
    size: "uint32",
    whenField: text(32),
    whenValue: "int32",
    field: text(32),
    onlyValue: "int32",
    reason: text(128),
  }),
};
const OUTPUT = { stroke: 1, segment: 2, events: 4, recursion: 8, nested: 16 };
const api = {
  version: library.func("int32_t czsc_api_version(void)"),
  error: library.func("const char *czsc_last_error(void)"),
  commit: library.func("const char *czsc_build_commit(void)"),
  configDefault: library.func(
    "int32_t czsc_config_default(_Out_ czsc_config *out)",
  ),
  validate: library.func("int32_t czsc_config_validate(const czsc_config *c)"),
  configId: library.func(
    "int32_t czsc_config_id(const czsc_config *c, _Out_ uint8_t *out, int32_t cap)",
  ),
  projectionDefault: library.func(
    "int32_t czsc_projection_default(_Out_ czsc_projection *out)",
  ),
  build: library.func(
    "void *czsc_build(const czsc_input *input, const czsc_config *c, uint32_t outputs)",
  ),
  setProjection: library.func(
    "int32_t czsc_set_projection(void *snapshot, const czsc_projection *p)",
  ),
  free: library.func("void czsc_snapshot_free(void *snapshot)"),
  fields: library.func("czsc_config_fields", "int32_t", [
    koffi.out(koffi.pointer(schemaRows.fields)),
    "int32_t",
  ]),
  choices: library.func("czsc_config_choices", "int32_t", [
    koffi.out(koffi.pointer(schemaRows.choices)),
    "int32_t",
  ]),
  rules: library.func("czsc_config_rules", "int32_t", [
    koffi.out(koffi.pointer(schemaRows.rules)),
    "int32_t",
  ]),
};
const levelTable = (name: string) =>
  library.func(
    `const void *${name}(void *snapshot, int32_t level, _Out_ int32_t *count)`,
  );
const tables = {
  pivots: [levelTable("czsc_level_pivots"), structs.pivot],
  centers: [levelTable("czsc_level_centers"), structs.center],
  movements: [levelTable("czsc_level_movements"), structs.movement],
  breakouts: [levelTable("czsc_level_breakouts"), structs.breakout],
  signals: [levelTable("czsc_level_signals"), structs.signal],
  events: [levelTable("czsc_level_events"), structs.event],
  bars: [levelTable("czsc_level_bars"), structs.bar],
  nodes: [levelTable("czsc_level_recursive_nodes"), structs.node],
  children: [levelTable("czsc_level_recursive_children"), "int32"],
  recursiveCenters: [
    levelTable("czsc_level_recursive_centers"),
    structs.recursiveCenter,
  ],
  connections: [
    levelTable("czsc_level_recursive_connections"),
    structs.connection,
  ],
} as const;
const nestedRows = library.func(
  "const void *czsc_nested_rows(void *snapshot, _Out_ int32_t *count)",
);

const version = api.version() as number;
if (version !== czscApiVersion)
  throw new Error(`CZSC API v${version} ≠ required v${czscApiVersion}`);
const buildCommit = (api.commit() as string | null) ?? "unknown";

function read(
  fn: (...args: unknown[]) => unknown,
  type: unknown,
  handle: unknown,
  level?: number,
) {
  const count = [0];
  const pointer =
    level === undefined ? fn(handle, count) : fn(handle, level, count);
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

const failure = (what: string) =>
  new Error(`${what}: ${(api.error() as string | null) ?? "unknown"}`);

function schemaRowsOf<T>(
  fn: (out: unknown, cap: number) => unknown,
  type: unknown,
): T[] {
  const n = fn(null, 0) as number;
  if (n <= 0) return [];
  const out = Array.from({ length: n }, () => ({}));
  const written = fn(out, n) as number;
  return (out.slice(0, written) as (T & { size?: number })[]).map((row) => {
    if (row.size !== koffi.sizeof(type as never))
      throw new Error("CZSC struct size mismatch");
    delete row.size;
    return row as T;
  });
}
function schema(): CzscConfigSchema {
  return {
    fields: schemaRowsOf(api.fields, schemaRows.fields),
    choices: schemaRowsOf(api.choices, schemaRows.choices),
    rules: schemaRowsOf(api.rules, schemaRows.rules),
  };
}

/** DLL defaults overlaid with the request; invalid combinations throw the DLL's reason. */
function resolveConfig(overrides: Partial<CzscConfig> = {}) {
  const c = {} as CzscConfig & { size: number };
  if (api.configDefault(c) !== 0) throw failure("CZSC config default");
  Object.assign(c, overrides, { size: koffi.sizeof(config) });
  if (api.validate(c) !== 0)
    throw new RangeError(
      `缠论配置无效：${(api.error() as string | null) ?? ""}`,
    );
  const cap = api.configId(c, null, 0) as number;
  const buffer = Buffer.alloc(Math.max(cap, 1));
  if (cap <= 0 || (api.configId(c, buffer, cap) as number) < 0)
    throw failure("CZSC config id");
  return { c, id: buffer.toString("utf8", 0, buffer.indexOf(0)) };
}

// Synchronous IPC handler; handles never outlive one message.
process.on(
  "message",
  (message: {
    id: number;
    /** Return the v20 configuration schema instead of building. */
    schema?: boolean;
    input: CzscInput;
    request: CzscRequest;
  }) => {
    let handle: unknown = null;
    try {
      if (message.schema) {
        process.send?.({ id: message.id, result: schema() });
        return;
      }
      const request = message.request;
      const { high, low, close, volume } = czscInput(message.input);
      const n = high.length;
      if (n > 16777216)
        throw new RangeError("CZSC input exceeds exact index domain");
      const levels = request.levels ?? [0, 1];
      if (!levels.length || levels.some((l) => l !== 0 && l !== 1))
        throw new RangeError("Invalid CZSC levels");
      const { c, id: configId } = resolveConfig(request.config);
      const outputs =
        (levels.includes(0) ? OUTPUT.stroke : 0) |
        (levels.includes(1) ? OUTPUT.segment : 0) |
        (request.events ? OUTPUT.events : 0) |
        (request.recursion ? OUTPUT.recursion : 0) |
        (request.nested ? OUTPUT.nested : 0);
      handle = api.build(
        { size: koffi.sizeof(input), n, high, low, close, volume },
        c,
        outputs,
      );
      if (!handle) throw failure("CZSC build failed");
      if (request.projection) {
        const p = {} as CzscProjection & { size: number };
        api.projectionDefault(p);
        Object.assign(p, request.projection, {
          size: koffi.sizeof(projection),
        });
        if (api.setProjection(handle, p) !== 0)
          throw failure("缠论显示投影无效");
      }
      // Decode and ship only what the caller uses: the per-bar table is a
      // row per bar of full history. Monitoring and the full-market ledger
      // call once per security, so this dominates IPC volume.
      const families: CzscSnapshot["families"] = {};
      for (const level of levels)
        families[level === 0 ? 0 : 1100] = Object.fromEntries(
          Object.entries(tables).map(([key, [fn, type]]) => [
            key,
            key !== "bars" || request.bars !== false
              ? read(fn as never, type, handle, level)
              : [],
          ]),
        ) as unknown as CzscRawFamily;
      const result: CzscSnapshot = {
        hash,
        apiVersion: version,
        buildCommit,
        configId,
        families,
        nested: request.nested
          ? (read(
              nestedRows as never,
              structs.nested,
              handle,
            ) as CzscSnapshot["nested"])
          : [],
      };
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (handle) api.free(handle);
    }
  },
);
// Keep the library reachable for the worker lifetime (koffi/doc/load.md).
process.on("disconnect", () => {
  library.unload();
  process.exit(0);
});

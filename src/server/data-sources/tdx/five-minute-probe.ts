import koffi from "koffi";
import { resolve } from "node:path";

function load() {
  const os = koffi.load("kernel32.dll");
  return {
    open: os.func(
      "void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)",
    ),
    size: os.func("int __stdcall GetFileSizeEx(void *, void *)"),
    mapping: os.func(
      "void * __stdcall CreateFileMappingW(void *, void *, uint32, uint32, uint32, str16)",
    ),
    view: os.func(
      "void * __stdcall MapViewOfFile(void *, uint32, uint32, uint32, size_t)",
    ),
    unmap: os.func("int __stdcall UnmapViewOfFile(void *)"),
    flush: os.func("int __stdcall FlushViewOfFile(void *, size_t)"),
    close: os.func("int __stdcall CloseHandle(void *)"),
    probe: koffi
      .load(resolve("runtime/tdx-import/probe.dll"))
      .func(
        "int lc5_probe(void *, uint32, const void *, uint32, void *, int, const void *, int, const void *)",
      ),
  };
}
let native: ReturnType<typeof load> | undefined;
/** Read-only mapped access avoids copying an entire multi-year history for an unchanged month.
 * Missing timestamps fall back to the normal writer; mappings are closed before any write.
 */
export function probeFiveMinuteFile(
  target: string,
  size: number,
  incoming: Buffer,
  legacyVolumes?: Buffer,
) {
  const result = mappedFiveMinuteFile(
    target,
    size,
    incoming,
    legacyVolumes,
    false,
  );
  return result
    ? { identical: result.identical, conflicts: result.conflicts }
    : null;
}

/** Authorized imports may repair exact legacy volume words in a fully covered range. */
export function repairFiveMinuteFile(
  target: string,
  size: number,
  incoming: Buffer,
  legacyVolumes: Buffer,
  sourceAmounts?: Buffer,
) {
  return mappedFiveMinuteFile(
    target,
    size,
    incoming,
    legacyVolumes,
    true,
    sourceAmounts,
  );
}

function mappedFiveMinuteFile(
  target: string,
  size: number,
  incoming: Buffer,
  legacyVolumes: Buffer | undefined,
  repair: boolean,
  sourceAmounts?: Buffer,
) {
  if (!size || size % 32 || size / 32 > 0xffffffff) return null;
  if (legacyVolumes && legacyVolumes.length !== incoming.length / 8)
    throw new Error("LC5 volume repair metadata length mismatch");
  if (sourceAmounts && sourceAmounts.length !== incoming.length / 8)
    throw new Error("LC5 source amount metadata length mismatch");
  const api = (native ??= load());
  const file = api.open(
    resolve(target),
    repair ? 0xc0000000 : 0x80000000,
    7,
    null,
    3,
    128,
    null,
  ) as bigint | null;
  if (!file || BigInt.asIntN(64, file) === -1n) return null;
  let mapping: bigint | null = null,
    view: bigint | null = null;
  try {
    const actualSize = Buffer.alloc(8);
    if (
      !api.size(file, actualSize) ||
      actualSize.readBigUInt64LE() !== BigInt(size)
    )
      return null;
    mapping = api.mapping(file, null, repair ? 4 : 2, 0, 0, null) as
      bigint | null;
    if (!mapping) return null;
    view = api.view(mapping, repair ? 2 : 4, 0, 0, 0) as bigint | null;
    if (!view) return null;
    const stats = Buffer.alloc(12);
    const result = api.probe(
      view,
      size / 32,
      incoming,
      incoming.length / 32,
      stats,
      new Date().getFullYear(),
      legacyVolumes ?? null,
      Number(repair),
      sourceAmounts ?? null,
    ) as number;
    if (result < 0) throw new Error("LC5 时间非法、重复或乱序");
    if (!result || (!repair && stats.readUInt32LE(8))) return null;
    if (repair && stats.readUInt32LE(8) && !api.flush(view, 0))
      throw new Error(
        "LC5 volume repair flush failed; rerun to verify persisted records",
      );
    return {
      identical: stats.readUInt32LE(),
      conflicts: stats.readUInt32LE(4),
      repaired: stats.readUInt32LE(8),
    };
  } finally {
    if (view) api.unmap(view);
    if (mapping) api.close(mapping);
    api.close(file);
  }
}

import { closeSync, openSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";

type Emit = (chunk: string) => void;

function isOmittedObjectValue(value: unknown) {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

function applyToJson(value: unknown, key: string) {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    return (value as { toJSON: (key: string) => unknown }).toJSON(key);
  }
  return value;
}

function emitJson(
  value: unknown,
  emit: Emit,
  ancestors: Set<object>,
  key = "",
  prepared = false,
  arrayItem = false,
): boolean {
  const jsonValue = prepared ? value : applyToJson(value, key);
  if (isOmittedObjectValue(jsonValue)) {
    if (arrayItem) emit("null");
    return false;
  }
  if (jsonValue === null) {
    emit("null");
    return true;
  }
  if (
    typeof jsonValue === "string" ||
    typeof jsonValue === "number" ||
    typeof jsonValue === "boolean"
  ) {
    const scalar = JSON.stringify(jsonValue);
    if (scalar === undefined) throw new TypeError("无法序列化 JSON 标量");
    emit(scalar);
    return true;
  }
  if (typeof jsonValue === "bigint")
    throw new TypeError("Do not know how to serialize a BigInt");
  if (typeof jsonValue !== "object")
    throw new TypeError(`无法序列化 JSON 值: ${typeof jsonValue}`);
  if (ancestors.has(jsonValue))
    throw new TypeError("Converting circular structure to JSON");
  ancestors.add(jsonValue);
  try {
    if (Array.isArray(jsonValue)) {
      emit("[");
      for (let index = 0; index < jsonValue.length; index += 1) {
        if (index) emit(",");
        emitJson(jsonValue[index], emit, ancestors, String(index), false, true);
      }
      emit("]");
      return true;
    }
    emit("{");
    let first = true;
    for (const property of Object.keys(jsonValue)) {
      const item = (jsonValue as Record<string, unknown>)[property];
      const normalized = applyToJson(item, property);
      if (isOmittedObjectValue(normalized)) continue;
      if (!first) emit(",");
      first = false;
      emit(JSON.stringify(property));
      emit(":");
      emitJson(normalized, emit, ancestors, property, true);
    }
    emit("}");
    return true;
  } finally {
    ancestors.delete(jsonValue);
  }
}

/** Emits the JSON.stringify-compatible representation without building one giant string. */
export function streamResearchJson(value: unknown, emit: Emit) {
  emitJson(value, emit, new Set<object>());
}

function isInvalidStringLength(error: unknown) {
  return (
    error instanceof Error && error.message.includes("Invalid string length")
  );
}

/**
 * Preserve the historical JSON.stringify hash for ordinary results, but fall
 * back to the same byte sequence emitted in chunks when V8 rejects the giant
 * string. This is needed for large structure-evidence results.
 */
export function researchJsonHash(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("无法序列化 JSON 值");
    return createHash("sha256").update(serialized).digest("hex");
  } catch (error) {
    if (!isInvalidStringLength(error)) throw error;
    const hash = createHash("sha256");
    streamResearchJson(value, (chunk) => hash.update(chunk));
    return hash.digest("hex");
  }
}

function writeAll(fd: number, chunk: string) {
  const bytes = Buffer.from(chunk, "utf8");
  let offset = 0;
  while (offset < bytes.length)
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/** Write the historical JSON bytes, falling back to chunked output at the V8 string limit. */
export function writeResearchJsonFile(path: string, value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("无法序列化 JSON 值");
    const fd = openSync(path, "w");
    try {
      writeAll(fd, serialized);
    } finally {
      closeSync(fd);
    }
    return;
  } catch (error) {
    if (!isInvalidStringLength(error)) throw error;
  }
  const fd = openSync(path, "w");
  try {
    streamResearchJson(value, (chunk) => writeAll(fd, chunk));
  } finally {
    closeSync(fd);
  }
}

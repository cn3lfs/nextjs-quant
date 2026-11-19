import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { thsdkSessionRoot } from "../../infra/paths";
import { findKnownThsdkDll } from "./thsdk-known-hashes";

export type StagedThsdkDll = {
  sourcePath: string;
  stagedPath: string;
  sha256: string;
  bytes: number;
  knownVersion: string | null;
};

export type ThsdkPathErrorCode =
  | "invalid_path"
  | "unlisted_hash"
  | "invalid_pe"
  | "too_large"
  | "hash_mismatch"
  | "io_error";

export class ThsdkPathError extends Error {
  constructor(
    public readonly code: ThsdkPathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ThsdkPathError";
  }
}

const MAX_DLL_BYTES = 32 * 1024 * 1024;
const driveAbsolutePattern = /^[A-Za-z]:\\/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

function invalidPath(message: string): ThsdkPathError {
  return new ThsdkPathError("invalid_path", message);
}

function lstatOrInvalid(path: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw invalidPath("DLL 路径不存在或不可访问");
  }
}

/**
 * Structural validation only; every segment is lstat'ed so junctions and
 * symlinks are rejected before the file is ever read or copied.
 */
export function validateThsdkDllPath(rawPath: string): string {
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.length > 32_767
  )
    throw invalidPath("DLL 路径无效");
  if (rawPath.startsWith("\\\\") || rawPath.startsWith("//"))
    throw invalidPath("DLL 路径不支持网络共享或设备路径");
  if (!driveAbsolutePattern.test(rawPath))
    throw invalidPath("DLL 路径必须是 Windows 盘符绝对路径");
  if (controlCharacterPattern.test(rawPath))
    throw invalidPath("DLL 路径包含非法字符");
  // Anything after the drive colon is an alternate data stream.
  if (rawPath.slice(2).includes(":"))
    throw invalidPath("DLL 路径不能包含备用数据流");
  if (/[. ]$/.test(rawPath)) throw invalidPath("DLL 路径段不能以点或空格结尾");

  const normalized = resolve(rawPath);
  const root = normalized.slice(0, 3);
  const relative = normalized.slice(3);
  if (!/^[A-Za-z]:\\$/.test(root) || relative.length === 0)
    throw invalidPath("DLL 路径无效");
  const segments = relative.split("\\");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/.test(segment) ||
      controlCharacterPattern.test(segment)
    )
      throw invalidPath("DLL 路径段无效");
  }

  let current = root;
  const rootInfo = lstatOrInvalid(current);
  if (rootInfo.isSymbolicLink()) throw invalidPath("DLL 路径包含符号链接");
  for (const segment of segments) {
    current = join(current, segment);
    const info = lstatOrInvalid(current);
    if (info.isSymbolicLink())
      throw invalidPath("DLL 路径不能包含符号链接或目录联接");
  }

  let realPath: string;
  try {
    realPath = realpathSync.native(normalized);
  } catch {
    throw invalidPath("DLL 路径无法解析");
  }
  // Windows is case-insensitive, so compare canonical forms without case.
  if (realPath.toLowerCase() !== normalized.toLowerCase())
    throw invalidPath("DLL 路径包含重定向或短名");

  return normalized;
}

export function inspectThsdkDllFile(filePath: string): {
  sha256: string;
  bytes: number;
  knownVersion: string | null;
} {
  const path = validateThsdkDllPath(filePath);
  let info: Stats;
  try {
    info = statSync(path);
  } catch {
    throw new ThsdkPathError("io_error", "DLL 文件无法读取");
  }
  if (!info.isFile())
    throw new ThsdkPathError("invalid_pe", "DLL 路径不是普通文件");
  if (info.size <= 0) throw new ThsdkPathError("invalid_pe", "DLL 文件为空");
  if (info.size > MAX_DLL_BYTES)
    throw new ThsdkPathError("too_large", "DLL 超过 32 MiB 上限");

  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    throw new ThsdkPathError("io_error", "DLL 文件无法读取");
  }
  try {
    const header = Buffer.alloc(64);
    const headerBytes = readSync(descriptor, header, 0, 64, 0);
    if (headerBytes < 64 || header[0] !== 0x4d || header[1] !== 0x5a)
      throw new ThsdkPathError("invalid_pe", "DLL 缺少 MZ 头");
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > info.size - 6)
      throw new ThsdkPathError("invalid_pe", "DLL 的 PE 头偏移无效");
    const peHeader = Buffer.alloc(6);
    if (readSync(descriptor, peHeader, 0, 6, peOffset) !== 6)
      throw new ThsdkPathError("invalid_pe", "DLL 的 PE 头不完整");
    if (
      peHeader[0] !== 0x50 ||
      peHeader[1] !== 0x45 ||
      peHeader[2] !== 0x00 ||
      peHeader[3] !== 0x00
    )
      throw new ThsdkPathError("invalid_pe", "DLL 缺少 PE 签名");
    if (peHeader.readUInt16LE(4) !== 0x8664)
      throw new ThsdkPathError("invalid_pe", "DLL 不是 Windows x64 模块");
  } finally {
    closeSync(descriptor);
  }

  const sha256 = sha256File(path);
  return {
    sha256,
    bytes: info.size,
    knownVersion: findKnownThsdkDll(sha256)?.version ?? null,
  };
}

function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    throw new ThsdkPathError("io_error", "DLL 文件无法读取");
  }
}

function isUncPath(path: string): boolean {
  const normalized = resolve(path);
  return normalized.startsWith("\\\\") || normalized.startsWith("//");
}

export async function stageThsdkDll(
  rawPath: string,
  options?: { allowUnlistedHash?: boolean; sessionRoot?: string },
): Promise<StagedThsdkDll> {
  const sourcePath = validateThsdkDllPath(rawPath);
  const inspected = inspectThsdkDllFile(sourcePath);
  if (inspected.knownVersion === null && options?.allowUnlistedHash !== true)
    throw new ThsdkPathError(
      "unlisted_hash",
      "DLL 哈希未收录，需显式允许未列出的版本",
    );

  const sessionRoot = options?.sessionRoot ?? thsdkSessionRoot();
  if (isUncPath(sessionRoot)) throw invalidPath("会话目录不能位于网络共享");
  const dllRoot = join(resolve(sessionRoot), "dll");
  const stagedPath = join(dllRoot, inspected.sha256, "hq.dll");

  try {
    await mkdir(join(dllRoot, inspected.sha256), { recursive: true });
  } catch {
    throw new ThsdkPathError("io_error", "DLL 暂存目录不可写");
  }

  if (sourcePath.toLowerCase() !== stagedPath.toLowerCase()) {
    const temporary = join(
      dllRoot,
      inspected.sha256,
      `.hq.dll.tmp-${process.pid}-${Date.now()}`,
    );
    try {
      await copyFile(sourcePath, temporary);
      // The staging root may legitimately be junctioned; only the source path
      // is held to the no-links rule, so verify the copy by hash alone.
      if (sha256File(temporary) !== inspected.sha256)
        throw new ThsdkPathError("hash_mismatch", "DLL 复制后哈希不一致");
      await rename(temporary, stagedPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof ThsdkPathError) throw error;
      throw new ThsdkPathError("io_error", "DLL 复制失败");
    }
  }

  await pruneStagedDlls(dllRoot, inspected.sha256);
  return {
    sourcePath,
    stagedPath,
    sha256: inspected.sha256,
    bytes: inspected.bytes,
    knownVersion: inspected.knownVersion,
  };
}

async function pruneStagedDlls(
  dllRoot: string,
  keepSha256: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dllRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keepSha256) continue;
    await rm(join(dllRoot, entry), { recursive: true, force: true }).catch(
      () => {},
    );
  }
}

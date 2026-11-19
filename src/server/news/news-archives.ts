import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  newsArchiveOptionLabel,
  newsArchiveRoleLabel,
  type NewsArchiveOption,
  type NewsArchiveOptions,
  type NewsArchiveRole,
  type NewsArchiveSelection,
  type NewsArchiveSourceRole,
  type NewsArchiveView,
} from "~/lib/news/news-archives";
import type { NewsArchiveSettings } from "~/lib/settings/news-source-settings";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Stable identity of the archive file, independent of the declared role. */
export function newsSourceIdentity(path: string) {
  const file = statSync(path);
  return digest([
    resolve(path).toLowerCase(),
    file.dev,
    file.ino,
    file.birthtimeMs,
  ]);
}

function configuration(value: NewsArchiveSettings) {
  return {
    primaryPath: value.clsDbPath ?? "",
    primaryRole: (value.clsDbRole ?? "unspecified") as NewsArchiveSourceRole,
    complementPath: value.clsComplementDbPath ?? "",
    complementRole: (value.clsComplementDbRole ?? "") as "" | NewsArchiveRole,
  };
}

function fileState(path: string): { ok: boolean; message: string | null } {
  try {
    return statSync(path).isFile()
      ? { ok: true, message: null }
      : { ok: false, message: "不是文件" };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "文件不存在"
          : "文件不可访问",
    };
  }
}

const realpath =
  typeof realpathSync.native === "function"
    ? realpathSync.native
    : realpathSync;

function canonicalPath(path: string) {
  try {
    const value = realpath(path);
    return process.platform === "win32" ? value.toLowerCase() : value;
  } catch {
    return null;
  }
}

function reliableFileIdentity(path: string) {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile() || stat.dev === 0n || stat.ino === 0n) return null;
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * Same-file detection for symlinks, Windows junctions and hardlinks. The R3
 * source hash includes the path, so it must not be used for this decision.
 */
export function sameArchiveFile(left: string, right: string) {
  if (left === right) return true;
  const leftReal = canonicalPath(left),
    rightReal = canonicalPath(right);
  if (leftReal && rightReal && leftReal === rightReal) return true;
  const leftId = reliableFileIdentity(left),
    rightId = reliableFileIdentity(right);
  return leftId !== null && rightId !== null && leftId === rightId;
}

/**
 * Configured sources with their declared roles. It never opens a database or
 * guesses a role: only a user-declared type can be selected. A complementary
 * archive that resolves to the same file as the primary is not offered twice.
 */
export function newsArchiveOptions(
  value: NewsArchiveSettings,
): NewsArchiveOptions {
  const { primaryPath, primaryRole, complementPath, complementRole } =
    configuration(value);
  const options: NewsArchiveOption[] = [];
  const notes: string[] = [];
  if (primaryPath) {
    const state = fileState(primaryPath);
    options.push({
      key: "primary",
      role: primaryRole,
      label: newsArchiveOptionLabel(primaryRole),
      primary: true,
      available: state.ok,
      message: state.message,
    });
  } else if (primaryRole !== "unspecified") {
    notes.push("主档案声明了类型但未填写路径，请在数据与连接设置中修正。");
  }
  if (complementPath) {
    if (complementRole) {
      const state = fileState(complementPath);
      options.push({
        key: "complement",
        role: complementRole,
        label: newsArchiveRoleLabel[complementRole],
        primary: false,
        available: state.ok,
        message: state.message,
      });
    } else {
      notes.push("互补档案已填写路径但未声明类型，请在数据与连接设置中修正。");
    }
  }
  const primary = options.find((option) => option.key === "primary");
  const complement = options.find((option) => option.key === "complement");
  if (primary && complement) {
    if (primary.role !== "unspecified" && primary.role === complement.role) {
      complement.available = false;
      complement.message = "与主档案声明同一类型，不能作为独立来源。";
      notes.push("主档案与互补档案声明了同一类型，只显示主档案；请修正配置。");
    } else if (sameArchiveFile(primaryPath, complementPath)) {
      complement.available = false;
      complement.message = "与主档案指向同一文件，不能作为独立来源。";
      notes.push("主档案与互补档案指向同一文件，只显示主档案；请修正配置。");
    }
  }
  const declared = new Set(
    options
      .filter((option) => option.role !== "unspecified")
      .map((option) => option.role),
  );
  return {
    options,
    unconfigured: (["all", "red"] as const)
      .filter((role) => !declared.has(role))
      .map((role) => ({ role, label: newsArchiveRoleLabel[role] })),
    note: notes.length ? notes.join(" ") : null,
  };
}

function view(option: NewsArchiveOption): NewsArchiveView {
  return {
    key: option.key,
    role: option.role,
    label: option.label,
    primary: option.primary,
  };
}

/**
 * Resolve exactly one archive. A missing role is an error; it never falls back
 * to the primary archive. No role keeps the original primary-archive behavior.
 */
export function resolveNewsArchive(
  value: NewsArchiveSettings,
  role?: NewsArchiveRole,
): NewsArchiveSelection {
  const { primaryPath, complementPath } = configuration(value);
  const options = newsArchiveOptions(value);
  if (!role) {
    const primary = options.options.find((option) => option.key === "primary");
    if (!primary) throw new Error("尚未配置新闻存档，请前往数据与连接设置");
    if (!primary.available)
      throw new Error(`新闻主档案不可读取：${primary.message ?? "请检查路径"}`);
    return { ...view(primary), path: primaryPath };
  }
  const available = options.options.find(
    (option) => option.role === role && option.available,
  );
  if (available)
    return {
      ...view(available),
      path: available.key === "primary" ? primaryPath : complementPath,
    };
  const configured = options.options.find((option) => option.role === role);
  if (configured)
    throw new Error(
      `「${configured.label}」档案不可用：${configured.message ?? "请检查配置"}`,
    );
  throw new Error(
    `未配置「${newsArchiveRoleLabel[role]}」档案；请在数据与连接设置中配置，或选择已配置的来源。`,
  );
}

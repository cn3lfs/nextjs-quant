import { resolveTdxRoot } from "tstdx/local";
import {
  readStableLocalFile,
  parseLocalBaseDbf,
  parseLocalBaseMap,
} from "tstdx/local";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  parseFinancialReport,
  parseFinancialSeries,
  parseFinancialFileList,
  parseStockFileList,
  parseLocalFinancialMd5,
} from "tstdx";
import {
  financialCatalog,
  financialDate,
  financialMappingVersion,
} from "trading-strategy-core/financial";
import {
  financialContext,
  financialDirectory,
  financialFileKind,
} from "./local-financial-files";

export async function auditLocalFinancialFiles(
  root: string,
  options: {
    verifyZip?: boolean;
    signal?: AbortSignal;
    progress?: (done: number, total: number) => void;
  } = {},
) {
  const directory = financialDirectory(root),
    names = (await readdir(directory)).sort();
  const context = await financialContext(root);
  const files: {
    filename: string;
    bytes: number;
    sha256: string | null;
    kind: string;
    status: string;
    records: number;
    reason: string | null;
  }[] = [];
  const counts: Record<string, number> = {},
    groups: Record<
      string,
      {
        records: number;
        files: number;
        first: number | null;
        last: number | null;
        undated: number;
      }
    > = {};
  const unknownSlots = new Map<number, { nonzero: number; records: number }>();
  const mappedSlots = new Set(
    financialCatalog
      .filter((f) => f.namespace === "FN" && f.slot !== null)
      .map((f) => f.slot!),
  );
  let observations = 0,
    missingAnnouncements = 0,
    suspiciousAnnouncements = 0,
    balanceConflicts = 0;
  const metadata: Record<string, number> = {},
    manifests = new Map<string, { md5: string; size: number }>();
  for (const name of ["gpcw.txt", "gpszsh.txt", "gpszsh.local"]) {
    if (!names.includes(name)) continue;
    try {
      const body = (await readStableLocalFile(resolve(directory, name))).body;
      if (name === "gpszsh.local")
        metadata[name] = Object.keys(parseLocalFinancialMd5(body)).length;
      else {
        const rows =
          name === "gpcw.txt"
            ? parseFinancialFileList(body)
            : parseStockFileList(body);
        metadata[name] = rows.length;
        for (const row of rows)
          manifests.set(row.filename, { md5: row.md5, size: row.filesize });
      }
      files.push({
        filename: name,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        kind: "metadata",
        status: "valid",
        records: metadata[name]!,
        reason: null,
      });
    } catch (error) {
      files.push({
        filename: name,
        bytes: 0,
        sha256: null,
        kind: "metadata",
        status: "invalid",
        records: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const dataNames = names.filter((name) =>
    /^(gpcw\d{8}\.(dat|zip)|gp(sh|sz|bj)\d{6}\.dat)$/i.test(name),
  );
  const datHashes = new Map<string, string>();
  for (let i = 0; i < dataNames.length; i++) {
    options.signal?.throwIfAborted();
    const name = dataNames[i]!,
      path = resolve(directory, name);
    const before = await stat(path);
    let kind = "unknown",
      status = "valid",
      records = 0,
      reason: string | null = null,
      hash: string | null = null;
    try {
      const body = (await readStableLocalFile(path)).body,
        after = await stat(path);
      if (
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size
      )
        throw new Error("读取期间源文件更新");
      hash = createHash("sha256").update(body).digest("hex");
      const manifest = manifests.get(name);
      if (
        manifest &&
        (manifest.size !== body.length ||
          manifest.md5 !== createHash("md5").update(body).digest("hex"))
      )
        throw new Error("下载清单长度或MD5不符");
      if (/^gpcw/i.test(name)) {
        kind = name.endsWith(".zip") ? "report-zip" : "report";
        if (kind === "report-zip" && !options.verifyZip) status = "not-checked";
        else {
          const data = parseFinancialReport(body, name);
          status = data.status;
          records = data.recordCount;
          if (kind === "report") datHashes.set(name, data.contentSha256);
          else if (
            datHashes.get(name.replace(/\.zip$/i, ".dat")) !==
            data.contentSha256
          )
            throw new Error("DAT与ZIP解压内容不一致");
          if (kind === "report" && data.status === "valid") {
            observations += records;
            for (const record of data.records) {
              const date = financialDate(
                record.values[313] ?? 0,
                Math.floor(data.reportDate / 10000),
              );
              if (!date) missingAnnouncements++;
              else if (Number(date.replaceAll("-", "")) <= data.reportDate)
                suspiciousAnnouncements++;
              const [assets, liabilities, equity] = [39, 62, 71].map(
                (slot) => record.values[slot]!,
              );
              if (
                Math.abs(assets! - liabilities! - equity!) >
                Math.max(
                  1,
                  Math.abs(assets!),
                  Math.abs(liabilities! + equity!),
                ) *
                  1e-5
              )
                balanceConflicts++;
              record.values.forEach((raw, slot) => {
                if (mappedSlots.has(slot)) return;
                const count = unknownSlots.get(slot) ?? {
                  nonzero: 0,
                  records: 0,
                };
                count.records++;
                if (raw !== 0) count.nonzero++;
                unknownSlots.set(slot, count);
              });
            }
          }
        }
      } else {
        const symbol = name.slice(2, -4);
        kind = financialFileKind(symbol, context);
        const data = parseFinancialSeries(body);
        records = data.records.length;
        if (kind === "unknown") {
          status = "unclassified";
          reason = "本地主档不能证明序列类别，原始记录已解析";
        }
        const fileGroups = new Set<number>();
        for (const record of data.records) {
          const key = `${kind}${record.group}`,
            group = groups[key] ?? {
              records: 0,
              files: 0,
              first: null,
              last: null,
              undated: 0,
            };
          group.records++;
          if (!fileGroups.has(record.group)) {
            group.files++;
            fileGroups.add(record.group);
          }
          if (record.date === null) group.undated++;
          else {
            group.first = Math.min(group.first ?? record.date, record.date);
            group.last = Math.max(group.last ?? record.date, record.date);
          }
          groups[key] = group;
        }
      }
    } catch (error) {
      status = "invalid";
      reason = error instanceof Error ? error.message : String(error);
    }
    counts[`${kind}:${status}`] = (counts[`${kind}:${status}`] ?? 0) + 1;
    files.push({
      filename: name,
      bytes: before.size,
      sha256: hash,
      kind,
      status,
      records,
      reason,
    });
    if (i % 100 === 0 || i === dataNames.length - 1)
      options.progress?.(i + 1, dataNames.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const otherFiles = names.filter(
    (name) => !dataNames.includes(name) && !Object.hasOwn(metadata, name),
  );
  const candidates = [];
  for (const name of ["base.dbf", "base.map", "fundinfo.dat"]) {
    try {
      const path = resolve(resolveTdxRoot(root), "T0002", "hq_cache", name),
        info = await stat(path);
      const body = (await readStableLocalFile(path)).body;
      const parsed =
        name === "base.dbf"
          ? parseLocalBaseDbf(body)
          : name === "base.map"
            ? parseLocalBaseMap(body)
            : null;
      candidates.push({
        name,
        bytes: info.size,
        sha256: createHash("sha256").update(body).digest("hex"),
        status: parsed
          ? "structure-verified-semantics-unverified"
          : "opaque-carrier",
        records: parsed?.rows.length ?? null,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    version: financialMappingVersion,
    root: resolveTdxRoot(root),
    observedAt: Date.now(),
    counts,
    files,
    groups,
    observations,
    missingAnnouncements,
    suspiciousAnnouncements,
    balanceConflicts,
    unknownSlots: [...unknownSlots].map(([slot, count]) => ({
      slot: slot + 1,
      ...count,
    })),
    metadata,
    otherFiles,
    go: {
      status: "no-verified-local-carrier",
      fields: financialCatalog.filter((f) => f.namespace === "GO").length,
      candidates,
      reason:
        "base.dbf自描述列和base.map文本结构已解析；旧列名与GO映射未核验，fundinfo.dat不透明，不据此提供GO数值",
    },
    contextWarning: context.warning,
    manifestHash: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
  };
}

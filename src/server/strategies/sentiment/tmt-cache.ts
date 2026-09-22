import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Evidence, Snapshot } from "~/lib/domain";
import { evidenceEnvelope } from "../../infra/evidence";
import {
  tmtCrowding,
  tmtCodes,
  swIndustries,
  tmtVersion,
  type TmtInput,
} from "./tmt-crowding";
import { verifiedIndustry } from "../../research/industry-news-evidence";
import { isAStock } from "../../data-sources/tdx/tdx";
import { put } from "../../db";
import { sharedRead } from "../../infra/shared-read";
import type { SkillUse } from "../../research/research-skills";
import { z } from "zod";
import { updateTmtMargin } from "./tmt-margin-update";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const files = ["amount.csv", "sw_daily.csv", "margin_sse.csv"] as const;
// CSV from pandas includes BOM and may quote fields. Do not execute or eval cells.
export function parseTmtCsv(text: string): Record<string, string>[] {
  if (Buffer.byteLength(text) > 20 * 1024 * 1024)
    throw new Error("TMT缓存文件超出20MB预算");
  const rows: string[][] = [],
    row: string[] = [];
  let field = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, "");
  const cell = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const line = () => {
    cell();
    if (row.some((v) => v !== "")) rows.push([...row]);
    row.length = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ",") cell();
    else if (c === "\n") line();
    else if (c === "\r" && text[i + 1] === "\n") {
      line();
      i++;
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error("CSV引号结构异常");
      field += c;
    }
    if (field.length > 1024 || row.length > 100 || rows.length > 500000)
      throw new Error("CSV字段或行数超出预算");
  }
  if (quoted) throw new Error("CSV引号未关闭");
  if (field || row.length || closed) line();
  const headers = rows.shift();
  if (
    !headers?.length ||
    new Set(headers).size !== headers.length ||
    headers.some((v) => !v)
  )
    throw new Error("CSV列头缺失或重复");
  return rows.map((r) => {
    if (r.length !== headers.length) throw new Error("CSV字段数量不匹配");
    return Object.fromEntries(headers.map((h, i) => [h, r[i]!]));
  });
}
const number = (v: string | undefined) => {
  if (v === undefined) throw new Error("TMT缓存缺少必需列");
  if (v.trim() === "" || /^nan$/i.test(v.trim())) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()))
    throw new Error("TMT缓存数值格式非法");
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("TMT缓存数值非有限");
  return n;
};
const required = (r: Record<string, string>, key: string) => {
  const value = r[key];
  if (value === undefined || !value.trim())
    throw new Error(`TMT缓存缺少${key}`);
  return value;
};
export function tmtCsvInput(
  texts: { amount: string | null; daily: string | null; margin: string | null },
  cutoff: string,
): TmtInput {
  return normalizedCsv(texts, cutoff).input;
}
function normalizedCsv(
  texts: { amount: string | null; daily: string | null; margin: string | null },
  cutoff: string,
) {
  const unique = (text: string | null, keys: string[]) => {
    const rows = text === null ? [] : parseTmtCsv(text),
      map = new Map<string, Record<string, string>>();
    let removed = 0;
    for (const r of rows) {
      const id = JSON.stringify(keys.map((key) => required(r, key))),
        previous = map.get(id);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(r))
          throw new Error("TMT缓存同日记录存在字段冲突");
        removed++;
      } else map.set(id, r);
    }
    return { rows: [...map.values()], removed };
  };
  const amount = unique(texts.amount, ["日期", "代码"]),
    daily = unique(texts.daily, ["发布日期", "指数代码"]),
    margin = unique(texts.margin, ["信用交易日期"]);
  const input: TmtInput = {
    cutoff,
    maxAgeDays: 7,
    amount: amount.rows.map((r) => ({
      date: required(r, "日期"),
      code: required(r, "代码"),
      amount: number(r["成交额"]),
      close: number(r["收盘"]),
    })),
    daily: daily.rows.map((r) => ({
      date: required(r, "发布日期"),
      code: required(r, "指数代码"),
      name: required(r, "指数名称"),
      turnover: number(r["换手率"]),
      pe: number(r["市盈率"]),
      pb: number(r["市净率"]),
      capital: number(r["流通市值"]),
    })),
    margin: margin.rows.map((r) => {
      const d = required(r, "信用交易日期");
      if (!/^\d{8}$/.test(d)) throw new Error("融资日期格式非法");
      return {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`,
        balance: number(r["融资余额"]),
      };
    }),
  };
  return { input, duplicates: [amount.removed, daily.removed, margin.removed] };
}
type Cache = {
  key: string;
  input: TmtInput;
  sources: {
    file: string;
    hash: string;
    archiveId: string;
    identicalRowsRemoved: number;
  }[];
  readAt: number;
  facts: ReturnType<typeof tmtCrowding>;
};
let cached: Cache | undefined;
const shared = sharedRead<Cache>();
async function info(path: string) {
  try {
    // Runtime, user-owned CSV paths must not become deployment dependencies.
    const s = await stat(/* turbopackIgnore: true */ path);
    if (!s.isFile() || s.size > 20 * 1024 * 1024)
      throw new Error("TMT缓存文件大小或类型非法");
    return { size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}
export async function readTmtCache(
  root: string,
  cutoff: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const metadata = await Promise.all(
    files.map((f) => info(join(/* turbopackIgnore: true */ root, f))),
  );
  const key = JSON.stringify({
    root,
    metadata,
    dataDirectory: process.env.QUANT_DATA_DIR,
  });
  const data = await shared(
    key,
    async (s) => {
      if (cached?.key === key) return cached;
      const texts = await Promise.all(
        files.map(async (f, i) =>
          metadata[i]
            ? readFile(
                /* turbopackIgnore: true */ join(
                  /* turbopackIgnore: true */ root,
                  f,
                ),
                "utf8",
              )
            : null,
        ),
      );
      s.throwIfAborted();
      const after = await Promise.all(
        files.map((f) => info(join(/* turbopackIgnore: true */ root, f))),
      );
      if (JSON.stringify(after) !== JSON.stringify(metadata))
        throw new Error("TMT缓存读取期间发生变化");
      const normalized = normalizedCsv(
        { amount: texts[0]!, daily: texts[1]!, margin: texts[2]! },
        cutoff,
      );
      const input = normalized.input;
      // Validate before archiving; source-only timestamps are retained in each CSV.
      const facts = tmtCrowding(input);
      const sources = texts.flatMap((text, i) => {
        if (text === null) return [];
        const digest = hash(text),
          archiveId = `tmt-source-${digest}`;
        put("market-source", archiveId, {
          file: files[i],
          hash: digest,
          text,
          source: "本地tmt-crowding技能CSV缓存；原始网络响应未随缓存归档",
        });
        return [
          {
            file: files[i]!,
            hash: digest,
            archiveId,
            identicalRowsRemoved: normalized.duplicates[i]!,
          },
        ];
      });
      cached = { key, input, sources, readAt: Date.now(), facts };
      return cached;
    },
    signal,
  );
  signal?.throwIfAborted();
  if (data.input.cutoff === cutoff) return data;
  const input = { ...data.input, cutoff };
  cached = { ...data, input, facts: tmtCrowding(input) };
  return cached;
}

export async function tmtCandidateEvidence(
  source: Snapshot,
  evidence: Evidence[],
  signal?: AbortSignal,
): Promise<Evidence[]> {
  signal?.throwIfAborted();
  if (
    source.historicalAsOf ||
    source.period !== "day" ||
    !isAStock(source.symbol)
  )
    return [];
  const identity = verifiedIndustry(source.symbol, evidence, Date.now());
  if (!identity || !tmtCodes.some((c) => swIndustries[c] === identity.industry))
    return [];
  const missing = (text: string): Evidence[] => [
    {
      id: `missing-tmt-${source.symbol}`,
      source: "TMT拥挤度可用性",
      asOf: source.bars.at(-1)!.date,
      text,
    },
  ];
  try {
    signal?.throwIfAborted();
    const skills =
      process.env.QUANT_SKILLS_DIR ??
      join(homedir(), ".agent-skills", "skills");
    const documents = await Promise.all(
      ["SKILL.md", "scripts/tmt_crowding.py"].map(async (file) => {
        const text = await readFile(
          /* turbopackIgnore: true */ join(
            /* turbopackIgnore: true */ skills,
            "tmt-crowding",
            file,
          ),
          "utf8",
        );
        if (!text.trim()) throw new Error("TMT方法缺失");
        return { file, hash: hash(text) };
      }),
    );
    const cutoff = source.bars.at(-1)!.date.slice(0, 10),
      today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    if (cutoff > today || Date.parse(today) - Date.parse(cutoff) > 7 * 86400000)
      return missing("所选日线不是当前资料窗口，不调用当前TMT背景补历史。");
    const root =
      process.env.TMT_CROWDING_DATA_DIR ??
      join(skills, "..", "data", "tmt-crowding");
    const data = await updateTmtMargin(
      await readTmtCache(root, cutoff, signal),
      signal,
    );
    if (!data.facts.used)
      return missing(
        `TMT缓存缺失或过期（各来源最近有效日期：${[...new Set(data.facts.factors.map((f) => f.asOf ?? "无"))].join("、")}）；未生成当前拥挤度，不用旧缓存补当前。`,
      );
    const payload = {
      version: tmtVersion,
      method: {
        skillId: "tmt-crowding",
        version: tmtVersion,
        files: documents,
      },
      sources: data.sources,
      updates: {
        sourceIds: data.updates.sourceIds,
        sources: data.updates.sources,
        revisions: data.updates.revisions,
      },
      facts: data.facts,
    };
    const dates = [
      ...new Set(
        data.facts.factors.filter((f) => f.value !== null).map((f) => f.asOf!),
      ),
    ];
    const envelope = evidenceEnvelope(payload, {
      source: "tmt-crowding/background",
      symbol: null,
      type: "quote-financial",
      asOf: dates.length === 1 ? dates[0]! : null,
      publishedAt: null,
      fetchedAt: data.readAt,
      currency: null,
      unit: { score: "0–100", amountShare: "%", pe: "倍", pb: "倍" },
      adjustment: "unknown",
      reportPeriod: null,
      quality: "partial",
      warnings: data.facts.warnings,
    });
    const background: Evidence = {
      id: `tmt-${envelope.payloadHash}`,
      source:
        data.facts.scope === "market-proxy-only"
          ? "TMT资料缺项 / 上交所市场融资代理"
          : "TMT拥挤度 / 本地技能缓存与增量 / JS计算",
      asOf: envelope.asOf ?? "逐维度日期",
      text: JSON.stringify(payload),
      envelope,
    };
    const association = {
      version: "tmt-association-1",
      symbol: source.symbol,
      identity,
      backgroundId: background.id,
      relationship: "仅申万一级TMT行业归属，不是个股拥挤度或买卖信号",
    };
    const linked = evidenceEnvelope(association, {
      ...envelope,
      source: "tmt-crowding/association",
      symbol: source.symbol,
    });
    return [
      background,
      {
        id: `tmt-link-${linked.payloadHash}`,
        source: `${source.symbol} / TMT行业关联`,
        asOf: background.asOf,
        text: JSON.stringify(association),
        envelope: linked,
      },
      ...(data.facts.scope === "market-proxy-only"
        ? missing(
            "仅上交所市场融资代理有效，缺少当前TMT专属指标，未生成TMT综合分数或拥挤等级。",
          )
        : []),
    ];
  } catch {
    signal?.throwIfAborted();
    return missing(
      "TMT方法或缓存无法核验，未生成拥挤度；请核对完整行业数据、日期与文件格式。",
    );
  }
}

export function tmtUsedMethods(evidence: Evidence[]): SkillUse[] {
  const found = evidence.find(
    (e) => e.envelope?.source === "tmt-crowding/background",
  );
  if (!found) return [];
  const schema = z.object({
    method: z.object({
      skillId: z.literal("tmt-crowding"),
      version: z.literal(tmtVersion),
      files: z
        .array(
          z.object({
            file: z.string(),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        )
        .length(2),
    }),
  });
  if (hash(found.text) !== found.envelope!.payloadHash)
    throw new Error("TMT方法证据哈希不匹配");
  const { method } = schema.parse(JSON.parse(found.text));
  return [
    {
      skillId: method.skillId,
      ruleVersion: method.version,
      outputSchema: tmtVersion,
      files: method.files,
      prerequisites: [
        "当前A股日线与唯一TMT行业归属",
        "有效日期内的本地CSV与逐维度缺项",
        "仅背景研究，不作为个股信号",
      ],
    },
  ];
}

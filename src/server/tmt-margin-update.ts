import { createHash } from "node:crypto";
import { z } from "zod";
import { get, put, atomic } from "./db";
import {
  querySseMargin,
  sseMarginRows,
  type SseMarginArchive,
} from "./sse-margin";
import { tmtCrowding, type TmtInput } from "./tmt-crowding";
import { sharedRead } from "./shared-read";

const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const headSchema = z.object({
  baselineHash: z.string(),
  sourceIds: z.array(z.string().regex(/^sse-margin-[a-f0-9]{64}$/)).max(500),
  hash: z.string(),
});
type Base = {
  key: string;
  input: TmtInput;
  facts: ReturnType<typeof tmtCrowding>;
  readAt: number;
  sources: {
    file: string;
    hash: string;
    archiveId: string;
    identicalRowsRemoved: number;
  }[];
};
export function mergeSseMargin(
  seed: TmtInput["margin"],
  archive: SseMarginArchive,
) {
  const incoming = sseMarginRows(archive);
  if (!incoming.length) throw new Error("融资来源未返回观测");
  const sorted = [...seed].sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(sorted.map((r) => r.date)).size !== sorted.length)
    throw new Error("融资基线日期重复");
  const latest = sorted.at(-1)?.date;
  if (latest && !incoming.some((r) => r.date === latest))
    throw new Error("融资增量未覆盖基线尾日，不能证明衔接");
  const rows = new Map(sorted.map((r) => [r.date, r]));
  const revisions: { date: string; before: number | null; after: number }[] =
    [];
  for (const r of incoming) {
    const old = rows.get(r.date);
    if (old && old.balance !== r.balance)
      revisions.push({ date: r.date, before: old.balance, after: r.balance });
    rows.set(r.date, r);
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),
    revisions,
  };
}
type Updated = Base & {
  updates: {
    sourceIds: string[];
    sources: {
      archiveId: string;
      source: string;
      start: string;
      end: string;
      fetchedAt: number;
      hash: string;
    }[];
    status: string;
    message: string;
    revisions: { date: string; before: number | null; after: number }[];
  };
};
let memo: { key: string; value: Updated; at: number } | undefined;
const shared = sharedRead<Updated>();
export async function updateTmtMargin(
  base: Base,
  signal?: AbortSignal,
): Promise<Updated> {
  signal?.throwIfAborted();
  const baselineHash = digest(base.input.margin),
    headId = `tmt-margin-head-${baselineHash}`;
  const cutoff = base.input.cutoff;
  return shared(
    `${base.key}:${cutoff}`,
    async (s) => {
      const now = Date.now(),
        today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
      if (
        cutoff > today ||
        Date.parse(today) - Date.parse(cutoff) > 7 * 86400000
      )
        throw new Error("融资更新只用于当前研究窗口");
      const raw = get<unknown>(headId);
      let head = raw === undefined ? undefined : headSchema.parse(raw);
      if (
        head &&
        (head.baselineHash !== baselineHash ||
          head.hash !== digest({ baselineHash, sourceIds: head.sourceIds }))
      )
        throw new Error("融资更新索引校验失败");
      let key = digest({ base: base.key, cutoff, head: head?.hash });
      if (
        memo?.key === key &&
        memo.value.updates.status !== "failed" &&
        now >= memo.at &&
        now - memo.at < 10 * 60000
      )
        return memo.value;
      let margin = base.input.margin,
        revisions: Updated["updates"]["revisions"] = [],
        readAt = base.readAt;
      const sourceIds = [...(head?.sourceIds ?? [])];
      const sources: Updated["updates"]["sources"] = [];
      const describe = (id: string, a: SseMarginArchive) => ({
        archiveId: id,
        source: "https://query.sse.com.cn/marketdata/tradedata/queryMargin.do",
        start: a.start,
        end: a.end,
        fetchedAt: a.fetchedAt,
        hash: a.hash,
      });
      for (const id of sourceIds) {
        const archive = get<SseMarginArchive>(id);
        if (
          !archive ||
          id !== `sse-margin-${archive.hash}` ||
          archive.fetchedAt > now
        )
          throw new Error("融资来源档案缺失或晚于当前时间");
        const merged = mergeSseMargin(margin, archive);
        margin = merged.rows;
        revisions.push(...merged.revisions);
        readAt = Math.max(readAt, archive.fetchedAt);
        sources.push(describe(id, archive));
      }
      let status = "cached",
        message = "融资历史已覆盖所选截止日";
      const latest = margin.at(-1)?.date;
      if (!latest || latest < cutoff) {
        const attemptId = `tmt-margin-attempt-${baselineHash}-${cutoff}`,
          attempt = get<{ at: number }>(attemptId);
        if (attempt && now >= attempt.at && now - attempt.at < 10 * 60000) {
          status = "cooldown";
          message = "10分钟内已查询过融资来源，复用已核验资料与缺项";
        } else
          try {
            if (sourceIds.length >= 500)
              throw new Error("融资增量档案达到本版本上限");
            const start = new Date(
              (latest
                ? Date.parse(latest)
                : Date.parse(cutoff) - 392 * 86400000) -
                7 * 86400000,
            )
              .toISOString()
              .slice(0, 10);
            const archive = await querySseMargin(
              start.replaceAll("-", ""),
              cutoff.replaceAll("-", ""),
              s,
            );
            const merged = mergeSseMargin(margin, archive);
            const id = `sse-margin-${archive.hash}`;
            s.throwIfAborted();
            const changed =
              merged.rows.length !== margin.length ||
              merged.revisions.length > 0;
            margin = merged.rows;
            revisions.push(...merged.revisions);
            if (changed) {
              sourceIds.push(id);
              sources.push(describe(id, archive));
            }
            readAt = Math.max(readAt, archive.fetchedAt);
            const content = { baselineHash, sourceIds };
            head = { ...content, hash: digest(content) };
            atomic(() => {
              put("market-source", id, archive);
              if (changed) put("market-source", headId, head);
              put("market-source", attemptId, { at: Date.now(), sourceId: id });
            });
            key = digest({
              base: base.key,
              cutoff,
              head: changed
                ? head.hash
                : raw === undefined
                  ? undefined
                  : headSchema.parse(raw).hash,
            });
            status =
              (margin.at(-1)?.date ?? "") < cutoff
                ? "lagging"
                : changed
                  ? "updated"
                  : "unchanged";
            message =
              status === "lagging"
                ? "源接口尚未提供截止日数据，保留真实日期，10分钟内不重复查询"
                : "融资增量已核验并另行归档；原CSV与原来源档案保留";
          } catch {
            s.throwIfAborted();
            put("market-source", attemptId, { at: now });
            status = "failed";
            message =
              "融资增量未通过来源/衔接核验，保留原历史，不替换为猜测数据";
          }
      }
      s.throwIfAborted();
      const input = { ...base.input, margin };
      const value: Updated = {
        ...base,
        input,
        readAt,
        facts: sourceIds.length ? tmtCrowding(input) : base.facts,
        updates: { sourceIds, sources, status, message, revisions },
      };
      memo = { key, value, at: Date.now() };
      return value;
    },
    signal,
  );
}

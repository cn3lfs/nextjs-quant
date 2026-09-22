import { z } from "zod";
import { symbolSchema, type Evidence } from "~/lib/domain";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "../../infra/evidence";
import { createHash } from "node:crypto";
import { get, put } from "../../db";
const table = z.object({
  status_code: z.literal(0),
  code_count: z.number().int().min(1).max(20000),
  datas: z.array(z.record(z.unknown())),
  columns: z.array(
    z.object({
      key: z.string(),
      timestamp: z.string().optional(),
      unit: z.string().optional(),
      type: z.string().optional(),
      sort_info: z.string().optional(),
    }),
  ),
});
export function rankDetails(symbol: string, raw: unknown) {
  symbolSchema.parse(symbol);
  const result = table.parse(raw);
  if (
    result.datas.length !== 1 ||
    result.datas[0]!["股票代码"] !==
      `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("RS证券身份不匹配");
  validateHithinkColumns(result.datas[0]!, result.columns);
  const fields = result.columns.filter((c) =>
    /^涨跌幅排名\[\d{8}-\d{8}\]$/.test(c.key),
  );
  if (fields.length !== 1 || !fields[0]!.timestamp)
    throw new Error("RS排名区间未知");
  const rank = result.datas[0]![fields[0]!.key];
  if (
    typeof rank !== "number" ||
    !Number.isSafeInteger(rank) ||
    rank < 1 ||
    rank > 20000
  )
    throw new Error("RS排名非法");
  return { result, rank, range: fields[0]!.timestamp };
}
export function verifiedRank(
  symbol: string,
  raw: unknown,
  universeRaw: unknown,
  pageRaw: unknown,
) {
  const target = rankDetails(symbol, raw),
    universe = table.parse(universeRaw),
    page = table.parse(pageRaw);
  const key = `涨跌幅[${target.range}]`;
  const ordered = (data: typeof universe) =>
    data.columns.some(
      (c) =>
        c.key === key &&
        c.timestamp === target.range &&
        c.unit === "%" &&
        c.sort_info === "desc",
    );
  page.datas.forEach((row) => validateHithinkColumns(row, page.columns));
  const position = (target.rank - 1) % 10;
  const row = page.datas[position];
  const consistent =
    target.rank <= universe.code_count &&
    universe.code_count === page.code_count &&
    ordered(universe) &&
    ordered(page) &&
    row?.["股票代码"] ===
      `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}` &&
    typeof row?.[key] === "number" &&
    row[key] === target.result.datas[0]![key];
  return {
    rank: target.rank,
    range: target.range,
    universeCount: universe.code_count,
    verified: consistent,
    percentile:
      consistent && universe.code_count > 1
        ? (1 - (target.rank - 1) / (universe.code_count - 1)) * 100
        : null,
    provenance: { target: target.result, universe, page },
    warnings: [
      "来源全A股降序列表位置百分位，定义100×(1-(rank-1)/(N-1))，不是多周期经典RS评级。",
      ...(!consistent
        ? [
            "单股排名与全A股列表数量、区间或对应分页位置未能一致核验，禁止计算或推断RS达标。",
          ]
        : []),
      "当前来源区间可能与本地60间隔窗口不同，不得跨时点拼接；未冻结全部成分，盘中变动或并列排序可能导致核验失败。",
    ],
  };
}
export function fullRsSnapshot(raw: unknown) {
  const data = table.parse(raw);
  if (data.datas.length !== data.code_count)
    throw new Error("RS列表未完整返回");
  const fields = data.columns.filter(
    (c) =>
      /^涨跌幅\[\d{8}-\d{8}\]$/.test(c.key) &&
      c.unit === "%" &&
      c.sort_info === "desc",
  );
  if (fields.length !== 1 || !fields[0]!.timestamp)
    throw new Error("RS区间或排序未知");
  const field = fields[0]!,
    seen = new Set<string>();
  const rows = data.datas.map((row) => {
    validateHithinkColumns(row, data.columns);
    const code = row["股票代码"],
      value = row[field.key];
    if (
      typeof code !== "string" ||
      !/^\d{6}\.(SH|SZ|BJ)$/.test(code) ||
      seen.has(code) ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    )
      throw new Error("RS列表身份或涨幅不完整");
    seen.add(code);
    return { code, change: value };
  });
  if (rows.some((row, i) => i > 0 && row.change > rows[i - 1]!.change))
    throw new Error("RS列表顺序不一致");
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return {
    id: `rs-universe-${hash}`,
    version: "rs-universe-1",
    hash,
    range: field.timestamp!,
    count: rows.length,
    rows,
    source: data,
  };
}
export function rankInSnapshot(
  symbol: string,
  snapshot: ReturnType<typeof fullRsSnapshot>,
) {
  symbolSchema.parse(symbol);
  const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
  const target = snapshot.rows.find((row) => row.code === code);
  if (!target) throw new Error("证券不在完整来源排名列表");
  const above = snapshot.rows.filter(
      (row) => row.change > target.change,
    ).length,
    equal = snapshot.rows.filter((row) => row.change === target.change).length;
  const midRank = above + (equal + 1) / 2;
  return {
    version: "rs-full-list-1",
    symbol,
    range: snapshot.range,
    universeCount: snapshot.count,
    change: target.change,
    rankStart: above + 1,
    rankEnd: above + equal,
    midRank,
    percentile:
      snapshot.count > 1
        ? (1 - (midRank - 1) / (snapshot.count - 1)) * 100
        : null,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    verified: true,
    warnings: [
      "按完整来源A股涨幅列表计算并列中位名次百分位，不是多周期经典RS评级。",
      "单次响应行数、唯一代码、数值和降序完整核验；来源A股范围仍以查询服务为准，未独立核对交易所名单。",
      "来源区间可能与本地60间隔不同，不能跨时点拼接。全量来源已存档，可追溯统计分母。",
    ],
  };
}
async function loadUniverse(signal: AbortSignal) {
  const pointer = get<{ id: string; fetchedAt: number }>("rs-universe-current");
  let observedAt = pointer?.fetchedAt ?? 0;
  let snapshot =
    pointer && Date.now() - pointer.fetchedAt < 30000
      ? get<ReturnType<typeof fullRsSnapshot>>(pointer.id)
      : undefined;
  if (!snapshot) {
    snapshot = fullRsSnapshot(
      await request(
        "hithink-astock-selector",
        "全部A股 近60个交易日涨跌幅 排名",
        signal,
        1,
        10000,
      ),
    );
    signal.throwIfAborted();
    observedAt = Date.now();
    if (!get(snapshot.id))
      put("rs-universe", snapshot.id, { ...snapshot, capturedAt: observedAt });
    put("cache", "rs-universe-current", {
      id: snapshot.id,
      fetchedAt: observedAt,
    });
  }
  return { snapshot, observedAt };
}
type Flight = {
  controller: AbortController;
  promise: ReturnType<typeof loadUniverse>;
  users: number;
};
let active: Flight | undefined;
function sharedUniverse(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!active) {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      promise: loadUniverse(controller.signal),
      users: 0,
    };
    active = flight;
    // Both branches consume settlement; no unhandled rejected finally promise.
    void flight.promise.then(
      () => {
        if (active === flight) active = undefined;
      },
      () => {
        if (active === flight) active = undefined;
      },
    );
  }
  const flight = active;
  flight.users++;
  return new Promise<Awaited<ReturnType<typeof loadUniverse>>>(
    (resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        flight.users--;
        if (!flight.users && active === flight) {
          active = undefined;
          flight.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (release()) reject(signal?.reason ?? new Error("任务已取消"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void flight.promise.then(
        (value) => {
          if (release()) resolve(value);
        },
        (error) => {
          if (release()) reject(error);
        },
      );
    },
  );
}
export async function queryRsEvidence(
  symbol: string,
  signal?: AbortSignal,
): Promise<Evidence> {
  symbolSchema.parse(symbol);
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  const { snapshot, observedAt } = await sharedUniverse(signal);
  signal?.throwIfAborted();
  const payload = rankInSnapshot(symbol, snapshot);
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-astock-selector/rs",
    symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt: observedAt,
    currency: null,
    unit: { percentile: "%" },
    adjustment: "unknown",
    reportPeriod: null,
    quality: "partial",
    warnings: payload.warnings,
  });
  return {
    id: `rs-${symbol}-${envelope.payloadHash.slice(0, 16)}`,
    source: "问财完整A股列表相对强度",
    asOf: payload.range,
    text: JSON.stringify(payload),
    envelope,
  };
}

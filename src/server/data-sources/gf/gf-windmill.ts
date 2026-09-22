import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Evidence } from "~/lib/domain";
import type { SkillUse } from "../../research/research-skills";
import { evidenceEnvelope } from "../../infra/evidence";
import { get, put } from "../../db";
import { sharedRead } from "../../infra/shared-read";

export const windmillVersion = "gf-windmill-1";
const endpoint = "https://mcp-api.gf.com.cn/server/mcp/windmill/mcp";
const tool = "valuation_windmill_get";
const pageSize = 10;
const maxPages = 20;
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  });
const percentile = z.number().finite().min(0).max(100).nullable();
const rowSchema = z
  .object({
    indexCode: z.string().regex(/^(?:(?:SH|SZ))?\d{6}$/),
    indexCode2: z.string().regex(/^\d{6}$/),
    indexExchange: z.number().int().nonnegative(),
    indexName: z.string().min(1).max(100),
    tradedate: date,
    pePercent: percentile,
    pbPercent: percentile,
    dataYears: z.number().int().min(0).max(100),
    indexAlgorithm: z.enum(["PE", "PB"]),
    valuationResult: z.string().max(10),
    valuationResultPB: z.string().max(10),
    fundCode: z.string().regex(/^\d{6}$/),
    fundName: z.string().min(1).max(100),
    fundType: z.string().max(30),
    earningTypeDesc: z.string().max(100),
    earning: z.number().finite().nullable(),
  })
  .refine((r) => r.indexCode.endsWith(r.indexCode2), "指数代码不一致")
  .refine(
    (r) => r.dataYears > 0 || (r.pePercent === null && r.pbPercent === null),
    "无历史窗口不能提供分位",
  );
export const windmillPageSchema = z.object({
  retcode: z.literal(0),
  data: z.object({
    list: z.array(rowSchema).max(pageSize),
    total: z
      .number()
      .int()
      .min(0)
      .max(pageSize * maxPages),
    page: z
      .number()
      .int()
      .min(0)
      .max(maxPages - 1),
    perPage: z.number().int().min(0).max(pageSize),
  }),
});
type Page = z.infer<typeof windmillPageSchema>;
export type WindmillArchive = {
  version: typeof windmillVersion;
  fetchedAt: number;
  pages: Page[];
  hash: string;
};

export function parseWindmillPages(
  raw: unknown[],
  fetchedAt: number,
): WindmillArchive {
  if (
    !Number.isSafeInteger(fetchedAt) ||
    fetchedAt < 0 ||
    fetchedAt > Date.parse("9999-12-31T15:59:59Z")
  )
    throw new Error("指数估值采集时间非法");
  const pages = raw.map((p) => windmillPageSchema.parse(p));
  const total = pages[0]?.data.total;
  if (
    total === undefined ||
    pages.length !== Math.max(1, Math.ceil(total / pageSize))
  )
    throw new Error("指数估值分页覆盖不完整");
  const seen = new Set<string>(),
    today = new Date(fetchedAt + 8 * 3600000).toISOString().slice(0, 10);
  for (const [i, { data }] of pages.entries()) {
    const expected = Math.min(pageSize, total - i * pageSize);
    if (
      data.page !== i ||
      data.total !== total ||
      data.list.length !== expected ||
      (data.perPage !== pageSize && data.perPage !== expected)
    )
      throw new Error("指数估值分页计数不一致");
    for (const row of data.list) {
      const id = `${row.indexExchange}:${row.indexCode2}`;
      if (seen.has(id)) throw new Error("指数估值存在重复指数");
      if (row.tradedate > today) throw new Error("指数估值源日期晚于采集日");
      seen.add(id);
    }
  }
  const content: Omit<WindmillArchive, "hash"> = {
    version: windmillVersion,
    fetchedAt,
    pages,
  };
  return { ...content, hash: digest(content) };
}

export function windmillEvidence(
  archive: WindmillArchive,
  cutoff: string,
  method: SkillUse,
): Evidence {
  date.parse(cutoff);
  const rebuilt = parseWindmillPages(archive.pages, archive.fetchedAt);
  if (archive.version !== windmillVersion || rebuilt.hash !== archive.hash)
    throw new Error("指数估值归档校验失败");
  const rows = rebuilt.pages.flatMap((p) => p.data.list);
  const eligible = rows.filter(
    (r) =>
      r.tradedate <= cutoff &&
      Date.parse(cutoff) - Date.parse(r.tradedate) <= 7 * 86400000,
  );
  if (!eligible.length)
    throw new Error("没有截止日前7个日历日内的指数估值资料");
  const payload = {
    version: windmillVersion,
    archiveId: `windmill-archive-${archive.hash}`,
    cutoff,
    maxAgeDays: 7,
    method,
    sourceTotal: rows.length,
    included: eligible.length,
    excluded: rows.length - eligible.length,
    rows: eligible.map((r) => ({
      ...r,
      constituentMarket: "未核验；指数发布场所或源交易所编码不等于成分市场",
      performanceUnit: null,
      missing: [
        ...(r.pePercent === null ? ["PE历史分位缺失"] : []),
        ...(r.pbPercent === null ? ["PB历史分位缺失"] : []),
        ...(r.dataYears === 0 ? ["历史分位窗口缺失"] : []),
      ],
    })),
    warnings: [
      "广发指数估值榜单，非全市场指数全集；每条历史窗口不同，不混算全A近10年分位或市场情绪总分。",
      "仅供当前研究；抓取时间不等于当时公开时间，不用于历史信号或无前视回测。",
      "指数与ETF仅为源关联，不证明候选属于该指数、同市场或受益；未核验成分市场、跟踪关系与当前ETF行情。",
      "PE/PB分位单位0–100，空值不是低估；保留源评价代码但不将其直接转换为买卖建议。",
      "历史表现保留源标签与数值，源响应未提供独立单位、起止日或复权口径，不参与收益计算。",
    ],
  };
  const dates = [...new Set(eligible.map((r) => r.tradedate))];
  const envelope = evidenceEnvelope(payload, {
    source: "gf-windmill/index-valuation",
    symbol: null,
    type: "quote-financial",
    asOf: dates.length === 1 ? dates[0]! : null,
    publishedAt: null,
    fetchedAt: archive.fetchedAt,
    currency: null,
    unit: { pePercent: "0–100", pbPercent: "0–100", dataYears: "年" },
    adjustment: "unknown",
    reportPeriod: null,
    quality: "partial",
    warnings: payload.warnings,
  });
  return {
    id: `windmill-${envelope.payloadHash}`,
    source: "广发 / 指数估值共享背景",
    asOf: envelope.asOf ?? "各指数日期分别披露",
    text: JSON.stringify(payload),
    envelope,
  };
}

async function method() {
  const text = await readFile(
    join(
      process.env.QUANT_SKILLS_DIR ??
        join(homedir(), ".agent-skills", "skills"),
      "gf-windmill",
      "SKILL.md",
    ),
    "utf8",
  );
  if (!text.trim()) throw new Error("指数估值方法文件为空");
  return {
    text,
    use: {
      skillId: "gf-windmill",
      ruleVersion: windmillVersion,
      outputSchema: windmillVersion,
      files: [
        {
          file: "SKILL.md",
          hash: createHash("sha256").update(text).digest("hex"),
        },
      ],
      prerequisites: [
        "当前日期及完整榜单分页",
        "逐指数保留PE/PB分位与历史窗口",
        "市场/ETF归属不能推断候选关系",
      ],
    } satisfies SkillUse,
  };
}

export async function fetchWindmillPages(
  request: (
    page: number,
    perPage: number,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  signal?: AbortSignal,
) {
  const pages: Page[] = [];
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted();
    const parsed = windmillPageSchema.parse(
      await request(page, pageSize, signal),
    );
    signal?.throwIfAborted();
    if (
      parsed.data.page !== page ||
      (pages.length && parsed.data.total !== pages[0]!.data.total)
    )
      throw new Error("指数估值分页变化");
    const expected = Math.min(pageSize, parsed.data.total - page * pageSize);
    if (
      parsed.data.list.length !== expected ||
      (parsed.data.perPage !== pageSize && parsed.data.perPage !== expected)
    )
      throw new Error("指数估值分页计数不一致");
    pages.push(parsed);
    if ((page + 1) * pageSize >= parsed.data.total)
      return parseWindmillPages(pages, Date.now());
  }
  throw new Error("指数估值超出分页预算");
}

async function loadRemote(signal: AbortSignal) {
  const config = parse(
    await readFile(join(homedir(), ".codex", "config.toml"), "utf8"),
  ) as unknown as {
    mcp_servers?: Record<string, { args?: string[]; url?: string }>;
  };
  const source = config.mcp_servers?.["gf-windmill"],
    args = source?.args ?? [];
  const at = args.indexOf("--url"),
    url = source?.url ?? (at >= 0 ? args[at + 1] : undefined);
  if (url !== endpoint) throw new Error("未配置已支持的广发指数估值服务");
  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--header") {
      const value = args[i + 1] ?? "",
        colon = value.indexOf(":");
      if (colon > 0 && value.slice(0, colon).toLowerCase() === "authorization")
        headers.Authorization = value.slice(colon + 1).trim();
    }
  const client = new Client({ name: "quant-windmill", version: "1.0.0" });
  const abort = () => {
    void client.close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers, redirect: "error" },
      }),
      { timeout: 15000 },
    );
    signal.throwIfAborted();
    const tools = await client.listTools(undefined, { timeout: 15000, signal });
    const definition = tools.tools.find((t) => t.name === tool);
    if (!definition || definition.inputSchema.type !== "object")
      throw new Error("指数估值工具契约缺失");
    const numeric = z.object({ type: z.enum(["number", "integer"]) });
    if (
      !z
        .object({ page: numeric, perPage: numeric })
        .safeParse(definition.inputSchema.properties).success ||
      (definition.inputSchema.required ?? []).some(
        (key) => key !== "page" && key !== "perPage",
      )
    )
      throw new Error("指数估值工具参数契约变化");
    return await fetchWindmillPages(async (page, perPage, callSignal) => {
      const result = await client.callTool(
        { name: tool, arguments: { page, perPage } },
        undefined,
        { timeout: 15000, signal: callSignal },
      );
      if (result.isError) throw new Error("指数估值工具失败");
      const blocks = result.content as Array<{ type: string; text?: string }>;
      const text = blocks.filter((b) => b.type === "text");
      if (text.length !== 1 || !text[0]!.text)
        throw new Error("指数估值响应结构异常");
      return JSON.parse(text[0]!.text) as unknown;
    }, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    await client.close().catch(() => {});
  }
}
const shared = sharedRead<WindmillArchive>();
export async function sharedWindmillContext(
  cutoff: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  try {
    date.parse(cutoff);
    const now = Date.now(),
      today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    if (cutoff > today || Date.parse(today) - Date.parse(cutoff) > 7 * 86400000)
      throw new Error("所选行情不属于当前研究窗口");
    const rules = await method();
    const archive = await shared(
      windmillVersion,
      async (sharedSignal) => {
        const cached = get<WindmillArchive>("windmill-cache-1"),
          time = Date.now();
        if (
          cached &&
          time >= cached.fetchedAt &&
          time - cached.fetchedAt < 30 * 60000
        ) {
          try {
            const checked = parseWindmillPages(cached.pages, cached.fetchedAt);
            if (
              checked.hash === cached.hash &&
              cached.version === windmillVersion
            )
              return checked;
          } catch {
            /* Invalid disposable cache is replaced only after a successful source read. */
          }
        }
        const fresh = await loadRemote(
          AbortSignal.any([sharedSignal, AbortSignal.timeout(45000)]),
        );
        sharedSignal.throwIfAborted();
        put("market-context", `windmill-archive-${fresh.hash}`, fresh);
        put("market-context", "windmill-cache-1", fresh);
        return fresh;
      },
      signal,
    );
    signal?.throwIfAborted();
    const evidence = windmillEvidence(archive, cutoff, rules.use);
    // Keep the method text available to the same shared prompt without tool authority.
    const methodEvidence: Evidence = {
      id: `windmill-method-${rules.use.files[0]!.hash}`,
      source: "gf-windmill方法（只读规则，不构成工具或交易授权）",
      asOf: "方法文件版本",
      text: rules.text,
    };
    return {
      evidence: [evidence, methodEvidence],
      skills: [rules.use],
      missing: [
        "已取得部分指数估值背景；全市场情绪、行业价格与资金背景仍不完整",
      ],
    };
  } catch {
    signal?.throwIfAborted();
    return {
      evidence: [] as Evidence[],
      skills: [] as SkillUse[],
      missing: [
        "指数估值背景不可用：请核对本机服务配置、源日期、完整分页或方法文件",
      ],
    };
  }
}

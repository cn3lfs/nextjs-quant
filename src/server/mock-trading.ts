import { evidenceEnvelope } from "./evidence";
import type { EvidenceEnvelope } from "~/lib/evidence-envelope";
import { fetch } from "undici";
import { z } from "zod";
import {
  tradeInputSchema,
  type TradeInput,
  type Position,
} from "~/lib/trade-ledger";

export const mockHost = "http://trade.10jqka.com.cn:8088";
export type MockAccount = {
  username: string;
  state: "creating" | "ready";
  account?: string;
  shareholders?: { gddm: string; scdm: string }[];
};
export type RemotePosition = {
  symbol: string;
  quantity: number;
  sellable: number;
  cost: number;
};
const numeric = z
  .union([z.number(), z.string().min(1)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const shareholder = z
  .object({
    gddm: z.string().min(1).optional(),
    gdzh: z.string().min(1).optional(),
    scdm: z.string().min(1),
  })
  .superRefine((s, ctx) => {
    if (!s.gddm && !s.gdzh)
      ctx.addIssue({
        code: "custom",
        path: ["gddm/gdzh"],
        message: "两套股东账号字段均缺失",
      });
    if (s.gddm && s.gdzh && s.gddm !== s.gdzh)
      ctx.addIssue({
        code: "custom",
        path: ["gddm/gdzh"],
        message: "两套字段冲突",
      });
  })
  .transform((s) => ({ gddm: s.gddm ?? s.gdzh!, scdm: s.scdm }));
export type MockResponseEvidence = {
  envelope: EvidenceEnvelope;
  path: string;
  httpStatus: number | null;
  rawBody: string | null;
  failures: { field: string; reason: string }[];
};
// Redact identity fields, known credentials even in free text, and unknown long IDs.
// Preserve empty strings: they are essential evidence for pending shareholders.
export function redactMockBody(raw: string, secrets: string[]): string {
  let value = raw;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    value = value.split(secret).join("[REDACTED]");
  value = value.replace(/skill_\d+/gi, "[REDACTED]");
  value = value.replace(
    /("(?:usrname|username|usrid|usid|userid|account|gddm|gdzh|gddh|gdh|token|password|authorization|secret|api[_-]?key)"\s*:\s*)("(?:[^"\\]|\\.)+"|\d+)/gi,
    '$1"[REDACTED]"',
  );
  return value.replace(/\b[A-Za-z]?\d{7,}\b/g, "[REDACTED]");
}
export class MockTradingAdapter {
  private history: MockResponseEvidence[] = [];
  diagnostics() {
    return structuredClone(this.history);
  }

  constructor(
    readonly deps: {
      enabled: () => boolean;
      read: () => Promise<MockAccount | undefined>;
      save: (value: MockAccount) => Promise<void>;
      baseUrl?: string;
      retain?: (entry: MockResponseEvidence) => void;
    },
  ) {}
  private guard() {
    if (!this.deps.enabled()) throw new Error("同花顺模拟盘未开启");
  }
  private async request(
    path: string,
    params: Record<string, string>,
    validate?: (value: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    this.guard();
    const url = new URL(path, this.deps.baseUrl ?? mockHost);
    url.search = new URLSearchParams({
      datatype: "json",
      ...params,
    }).toString();
    const identity = await this.deps.read();
    this.guard();
    const secrets = [
      identity?.username,
      identity?.account,
      ...(identity?.shareholders?.map((s) => s.gddm) ?? []),
      ...Object.entries(params)
        .filter(([k]) => /usr|usid|name|gddh/.test(k))
        .map(([, v]) => v),
    ].filter((s): s is string => !!s);
    let rawBody: string | null = null,
      httpStatus: number | null = null;
    const failures: MockResponseEvidence["failures"] = [];
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      httpStatus = response.status;
      const originalBody = await response.text();
      rawBody = redactMockBody(originalBody, secrets);
      if (path === "/pt_add_user")
        rawBody = rawBody.replace(
          /("errormsg"\s*:\s*)"[^"\n]+"/g,
          '$1"[REDACTED]"',
        );
      if (!response.ok) {
        failures.push({ field: "$http", reason: `HTTP ${response.status}` });
        throw new Error();
      }
      // Parse the original body only in memory; retained text is already redacted.
      const value = z.record(z.unknown()).parse(JSON.parse(originalBody));
      const success =
        path === "/pt_qry_busin_nocache" && value.ret !== undefined
          ? z
              .object({
                ret: z.object({
                  code: z.union([z.literal(0), z.literal("0")]),
                }),
              })
              .safeParse(value).success
          : path === "/pt_qry_fund_t" &&
              value.errorcode === undefined &&
              value.code === undefined
            ? value.errormsg === ""
            : [0, "0"].includes(value.errorcode as string | number) ||
              [0, "0"].includes(value.code as string | number);
      if (!success) {
        failures.push({ field: "errorcode/code", reason: "成功码必须为 0" });
        throw new Error();
      }
      validate?.(value);
      return value;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fields = (
          issues: z.ZodIssue[],
        ): MockResponseEvidence["failures"] =>
          issues.flatMap((i) =>
            i.code === "invalid_union"
              ? i.unionErrors.flatMap((e) => fields(e.issues))
              : [{ field: i.path.join(".") || "$", reason: i.code }],
          );
        failures.push(...fields(error.issues));
      }
      if (!failures.length)
        failures.push({
          field: httpStatus === null ? "$transport" : "$json",
          reason: "请求失败或响应格式无效",
        });
      // Neither remote error strings nor request URLs may leave this boundary:
      // both can contain the username/account credential. Never retry mutations.
      throw new Error(
        "模拟盘请求失败或返回格式无效、不符合契约；操作结果可能未知，请人工核对，勿重复提交",
      );
    } finally {
      const entry: MockResponseEvidence = {
        path,
        httpStatus,
        rawBody,
        failures,
        envelope: evidenceEnvelope(rawBody, {
          source: "mock-trading",
          symbol: null,
          type: "quote-financial",
          asOf: null,
          publishedAt: null,
          fetchedAt: Date.now(),
          currency: null,
          unit: {},
          adjustment: "not-applicable",
          reportPeriod: null,
          quality: failures.length ? "unavailable" : "validated",
          warnings: ["payloadHash 对应脱敏响应文本；抓取时间不是成交时间"],
        }),
      };
      this.history = [...this.history, entry].slice(-20);
      this.deps.retain?.(entry);
    }
  }
  async open() {
    this.guard();
    const previous = await this.deps.read();
    if (previous?.state === "ready") return;
    if (previous) throw new Error("已有开户记录待核对，禁止自动重复开户");
    const pending: MockAccount = {
      username: `skill_${Date.now()}`,
      state: "creating",
    };
    // Save identity BEFORE external creation. An ambiguous response never creates
    // a second account. All account material lives exclusively in DPAPI storage.
    await this.deps.save(pending);
    const result = await this.request(
      "/pt_add_user",
      {
        usrname: pending.username,
        yybid: "997376",
      },
      (value) => {
        z.object({ errormsg: z.string().regex(/^\d+$/) }).parse(value);
      },
    );
    const account = z.string().regex(/^\d+$/).safeParse(result.errormsg);
    if (!account.success) throw new Error("开户响应无有效资金账号，请人工核对");
    await this.deps.save({ ...pending, account: account.data });
    await this.refreshShareholders();
  }
  // Explicit read-only recovery; never calls the creation endpoint or retries.
  async refreshShareholders() {
    this.guard();
    const pending = await this.deps.read();
    if (!pending?.account) throw new Error("无既有资金账号，禁止重复开户");
    const shares = await this.request(
      "/pt_qry_stkaccount_dklc",
      {
        usrid: pending.account,
        yybid: "997376",
      },
      (value) => {
        z.object({ result: z.array(shareholder).min(1) }).parse(value);
      },
    );
    await this.deps.save({
      ...pending,
      state: "ready",
      shareholders: z.array(shareholder).min(1).parse(shares.result),
    });
  }
  private async account() {
    this.guard();
    const value = await this.deps.read();
    if (
      !value ||
      value.state !== "ready" ||
      !value.account ||
      !value.shareholders?.length
    )
      throw new Error("请先在界面开户；已有开户结果未知时请人工核对");
    return value;
  }
  async positions(): Promise<RemotePosition[]> {
    const a = await this.account();
    const row = z.object({
      zqdm: z.string().regex(/^\d{6}$/),
      gpsl: numeric.pipe(z.number().int()),
      kysl: numeric.pipe(z.number().int()),
      gpcb: numeric,
    });
    const observedRow = row.extend({ djsl: numeric.pipe(z.number().int()) });
    // stock_query.py spells qry, whereas api-spec.md spells qy (nonexistent).
    // Observed today's shares are in djsl, corroborated by cjsl and market value.
    // Keep that component unavailable for selling; never treat kysl as total.
    const schema = z.union([
      z
        .object({ data: z.array(row.refine((p) => p.kysl <= p.gpsl)) })
        .transform((v) => v.data.map((p) => ({ ...p, quantity: p.gpsl }))),
      z
        .object({
          result: z.array(observedRow.refine((p) => p.kysl <= p.gpsl + p.djsl)),
        })
        .transform((v) =>
          v.result.map((p) => ({ ...p, quantity: p.gpsl + p.djsl })),
        ),
    ]);
    const result = await this.request(
      "/pt_web_qry_stock",
      {
        name: a.account!,
        yybid: "997376",
        type: "1",
      },
      (value) => {
        schema.parse(value);
      },
    );
    return schema.parse(result).map((p) => ({
      symbol: `${p.zqdm.startsWith("6") ? "sh" : /^[03]/.test(p.zqdm) ? "sz" : "bj"}${p.zqdm}`,
      quantity: p.quantity,
      sellable: p.kysl,
      cost: p.gpcb,
    }));
  }
  async funds() {
    const a = await this.account();
    const row = z.object({ zjye: numeric, kyje: numeric, dje: numeric });
    const schema = z.union([
      z
        .object({ result: z.object({ list: z.array(row) }) })
        .transform((v) => v.result.list),
      z
        .object({
          list: z.array(
            z.object({ zjye: numeric, kyje: numeric, djje: numeric }),
          ),
        })
        .transform((v) =>
          v.list.map((p) => ({ zjye: p.zjye, kyje: p.kyje, dje: p.djje })),
        ),
    ]);
    const result = await this.request(
      "/pt_qry_fund_t",
      { usrid: a.account! },
      (value) => {
        schema.parse(value);
      },
    );
    return schema.parse(result);
  }
  async todayTrades() {
    const a = await this.account();
    const row = z.object({
      zqdm: z.string().regex(/^\d{6}$/),
      mmlb: z.string().min(1),
      cjg: numeric,
      cje: numeric,
      cjsj: z.string().min(1),
      fee: numeric,
    });
    const schema = z.union([
      z
        .object({ ret: z.object({ item: z.array(row) }) })
        .transform((v) => v.ret.item),
      z
        .object({
          result: z.array(
            z.object({
              zqdm: z.string().regex(/^\d{6}$/),
              mmlb: z.enum(["买入", "卖出"]),
              cjjg: numeric,
              cjje: numeric,
              cjsl: numeric.pipe(z.number().int().positive()),
              cjsj: z.string().min(1),
              fee: numeric,
            }),
          ),
        })
        .transform((v) =>
          v.result.map((p) => ({
            zqdm: p.zqdm,
            mmlb: p.mmlb,
            cjg: p.cjjg,
            cje: p.cjje,
            cjsl: p.cjsl,
            cjsj: p.cjsj,
            fee: p.fee,
          })),
        ),
    ]);
    const result = await this.request(
      "/pt_qry_busin_nocache",
      { usrname: a.account!, kind: "1" },
      (value) => {
        schema.parse(value);
      },
    );
    return schema.parse(result);
  }

  async order(input: TradeInput, confirmed: boolean) {
    this.guard();
    if (!confirmed) throw new Error("下单必须在界面确认");
    const t = tradeInputSchema.parse(input),
      a = await this.account();
    const scdm = t.symbol.startsWith("sh")
      ? "2"
      : t.symbol.startsWith("sz")
        ? "1"
        : null;
    if (!scdm)
      throw new Error("模拟盘契约未提供北交所市场代码，仅支持本地记账");
    const share = a.shareholders!.find((s) => s.scdm === scdm);
    if (!share) throw new Error("该市场股东账号不可用");
    if (t.side === "sell") {
      const p = (await this.positions()).find((p) => p.symbol === t.symbol);
      if (!p || p.sellable < t.quantity)
        throw new Error("远程 T+1 可卖数量不足");
    }
    await this.request("/pt_stk_weituo_dklc", {
      usrid: a.account!,
      zqdm: t.symbol.slice(2),
      gddh: share.gddm,
      scdm,
      yybd: "997376",
      wtjg: String(t.price),
      wtsl: String(t.quantity),
      mmlb: t.side === "buy" ? "B" : "S",
    });
    return "委托请求已受理，不等于成交；请人工核对成交后另行记入本地账本";
  }
}
export function reconcilePositions(
  local: Position[],
  remote: RemotePosition[],
) {
  return [
    ...new Set([...local.map((p) => p.symbol), ...remote.map((p) => p.symbol)]),
  ]
    .sort()
    .map((symbol) => {
      const l = local.find((p) => p.symbol === symbol),
        r = remote.find((p) => p.symbol === symbol);
      return {
        symbol,
        localQuantity: l?.quantity ?? 0,
        remoteQuantity: r?.quantity ?? 0,
        quantityDifference: (l?.quantity ?? 0) - (r?.quantity ?? 0),
        localSellable: l?.sellable ?? 0,
        remoteSellable: r?.sellable ?? 0,
        localCost: l?.adjustedCost ?? null,
        remoteCost: r?.cost ?? null,
        costDifference:
          l?.adjustedCost != null && r ? l.adjustedCost - r.cost : null,
      };
    });
}

import { createHash } from "node:crypto";
import { evidenceEnvelope } from "../../infra/evidence";
import type { EvidenceEnvelope } from "~/lib/research/evidence/evidence-envelope";
import { fetch } from "undici";
import { z } from "zod";
import {
  tradeInputSchema,
  type TradeInput,
  type Position,
} from "~/lib/portfolio/trade-ledger";

export class MockSubmissionBlocked extends Error {}
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
export type MockTrade = {
  zqdm: string;
  mmlb: string;
  cjg: number;
  cje: number;
  cjsl?: number;
  cjsj: string;
  fee: number;
  /** Venue execution number; only read from an explicit response field. */
  tradeNo: string | null;
  entrustNo: string | null;
};
export type MockOrderReceipt = {
  message: string;
  entrustNos: string[];
  /** Credential snapshot that sent this order; queries must match it. */
  credentialRevision: string;
  /** Venue trading date; the trade endpoint only exposes the current day. */
  tradeDate: string;
};
/**
 * `fillStatus` separates "the venue accepted an order" from "we can attribute
 * executions to it". A response containing rows without an entrust number is
 * ambiguous: one of those rows could be ours, so neither a fill nor an empty
 * result can be asserted.
 */
export type MockFillStatus = "matched" | "unfilled" | "unknown";
type ReportedTrade = Omit<MockTrade, "fee"> & { fee?: number };
export type MockOrderStatus<T extends ReportedTrade = MockTrade> = {
  attributable: boolean;
  fillStatus: MockFillStatus;
  rows: T[];
  /** Why attribution is unavailable, for the operator-facing query result. */
  reason?: string;
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
// Entrust numbers are execution identifiers, not credentials. Accept both the
// documented spelling and the shorter one, normalize numeric values, and reject
// anything that is not a short identifier.
const entrustNoField = z.unknown().transform((value) => {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(text) ? text : null;
});
// A trade number is only used as a deduplication key; never synthesize one.
const tradeNoField = z.unknown().transform((value) => {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(text) ? text : null;
});
/** Drop identifiers that echo the credential exactly or are recognizably internal.
 * Substring rejection would discard legitimate IDs that merely contain an account. */
function identifierForAccount(
  value: string | null,
  account: MockAccount,
  maxLength: number,
): string | null {
  if (!value) return null;
  const text = value.trim();
  if (
    text.length === 0 ||
    text.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text) ||
    /^skill_/i.test(text)
  )
    return null;
  const secrets = [
    account.username,
    account.account,
    ...(account.shareholders?.map((s) => s.gddm) ?? []),
  ].filter((secret): secret is string => !!secret);
  if (secrets.some((secret) => secret.toLowerCase() === text.toLowerCase()))
    return null;
  return text;
}
export function entrustNoForAccount(
  value: string | null,
  account: MockAccount,
): string | null {
  return identifierForAccount(value, account, 24);
}
export function tradeNoForAccount(
  value: string | null,
  account: MockAccount,
): string | null {
  return identifierForAccount(value, account, 32);
}
/** Hash the credential snapshot so a query can prove it targets the sending account. */
export function mockCredentialRevision(account: MockAccount): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        account.username,
        account.account,
        account.shareholders ?? [],
      ]),
    )
    .digest("hex");
}
function entrustNosFromResponse(
  value: Record<string, unknown>,
  account: MockAccount,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of ["result", "list"]) {
    const rows = value[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const parsed = entrustNoForAccount(
        entrustNoField.parse(
          (row as Record<string, unknown>).entrust_no ??
            (row as Record<string, unknown>).entrustNo,
        ),
        account,
      );
      if (!parsed || seen.has(parsed)) continue;
      seen.add(parsed);
      result.push(parsed);
    }
  }
  return result;
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
    submissionBlock?: () => string | null,
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
    const reason = submissionBlock?.();
    if (reason) throw new MockSubmissionBlocked(reason);
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
  async todayTrades(): Promise<MockTrade[]> {
    return (await this.readTrades(false)).map((row) => ({
      ...row,
      fee: numeric.parse(row.fee),
    }));
  }
  private async readTrades(allowMissingFee: boolean): Promise<ReportedTrade[]> {
    const a = await this.account();
    const row = z.object({
      zqdm: z.string().regex(/^\d{6}$/),
      mmlb: z.string().min(1),
      cjg: numeric,
      cje: numeric,
      cjsj: z.string().min(1),
      fee: allowMissingFee ? numeric.optional() : numeric,
      entrust_no: entrustNoField,
      entrustNo: entrustNoField,
      trade_no: tradeNoField,
      tradeNo: tradeNoField,
      cjbh: tradeNoField,
    });
    const schema = z.union([
      z.object({ ret: z.object({ item: z.array(row) }) }).transform((v) =>
        v.ret.item.map((p) => ({
          zqdm: p.zqdm,
          mmlb: p.mmlb,
          cjg: p.cjg,
          cje: p.cje,
          cjsj: p.cjsj,
          fee: p.fee,
          tradeNo: tradeNoForAccount(p.trade_no ?? p.tradeNo ?? p.cjbh, a),
          entrustNo: entrustNoForAccount(p.entrust_no ?? p.entrustNo, a),
        })),
      ),
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
              fee: allowMissingFee ? numeric.optional() : numeric,
              entrust_no: entrustNoField,
              entrustNo: entrustNoField,
              trade_no: tradeNoField,
              tradeNo: tradeNoField,
              cjbh: tradeNoField,
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
            tradeNo: tradeNoForAccount(p.trade_no ?? p.tradeNo ?? p.cjbh, a),
            entrustNo: entrustNoForAccount(p.entrust_no ?? p.entrustNo, a),
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

  /** Read-only attribution: rows are matched exclusively by entrust number. */
  async orderStatus(entrustNos: readonly string[]): Promise<MockOrderStatus>;
  async orderStatus(
    entrustNos: readonly string[],
    allowMissingFee: boolean,
  ): Promise<MockOrderStatus<ReportedTrade>>;
  async orderStatus(
    entrustNos: readonly string[],
    allowMissingFee = false,
  ): Promise<MockOrderStatus<ReportedTrade>> {
    const rows = allowMissingFee
      ? await this.readTrades(true)
      : await this.todayTrades();
    const wanted = new Set(
      entrustNos.map((value) => value.trim()).filter((value) => value !== ""),
    );
    if (!wanted.size)
      return { attributable: false, fillStatus: "unknown", rows: [] };
    const matched = rows.filter(
      (row) => row.entrustNo !== null && wanted.has(row.entrustNo),
    );
    // A trade row without an entrust number could be the target order, so
    // neither "filled" nor "no fill" is safe while such rows exist.
    const ambiguous = rows.some((row) => row.entrustNo === null);
    return {
      attributable: !ambiguous && matched.length > 0,
      fillStatus: ambiguous
        ? "unknown"
        : matched.length
          ? "matched"
          : "unfilled",
      rows: matched,
    };
  }

  async order(
    input: TradeInput,
    confirmed: boolean,
    submissionBlock?: () => string | null,
  ): Promise<MockOrderReceipt> {
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
    const response = await this.request(
      "/pt_stk_weituo_dklc",
      {
        usrid: a.account!,
        zqdm: t.symbol.slice(2),
        gddh: share.gddm,
        scdm,
        yybd: "997376",
        wtjg: String(t.price),
        wtsl: String(t.quantity),
        mmlb: t.side === "buy" ? "B" : "S",
      },
      undefined,
      submissionBlock,
    );
    return {
      message: "委托请求已受理，不等于成交；请人工核对成交后另行记入本地账本",
      entrustNos: entrustNosFromResponse(response, a),
      credentialRevision: mockCredentialRevision(a),
      tradeDate: t.date,
    };
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

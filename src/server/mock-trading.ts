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
const shareholder = z.object({
  gddm: z.string().min(1),
  scdm: z.enum(["1", "2"]),
});
export class MockTradingAdapter {
  constructor(
    readonly deps: {
      enabled: () => boolean;
      read: () => Promise<MockAccount | undefined>;
      save: (value: MockAccount) => Promise<void>;
      baseUrl?: string;
    },
  ) {}
  private guard() {
    if (!this.deps.enabled()) throw new Error("同花顺模拟盘未开启");
  }
  private async request(
    path: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    this.guard();
    const url = new URL(path, this.deps.baseUrl ?? mockHost);
    url.search = new URLSearchParams({
      datatype: "json",
      ...params,
    }).toString();
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
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const value = z.record(z.unknown()).parse(await response.json());
      if (
        ![0, "0"].includes(value.errorcode as string | number) &&
        ![0, "0"].includes(value.code as string | number)
      )
        throw new Error();
      return value;
    } catch {
      // Neither remote error strings nor request URLs may leave this boundary:
      // both can contain the username/account credential. Never retry mutations.
      throw new Error(
        "模拟盘请求失败或返回不符合契约；操作结果可能未知，请人工核对，勿重复提交",
      );
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
    const result = await this.request("/pt_add_user", {
      usrname: pending.username,
      yybid: "997376",
    });
    const account = z.string().regex(/^\d+$/).safeParse(result.errormsg);
    if (!account.success) throw new Error("开户响应无有效资金账号，请人工核对");
    await this.deps.save({ ...pending, account: account.data });
    const shares = await this.request("/pt_qry_stkaccount_dklc", {
      usrid: account.data,
      yybid: "997376",
    });
    const parsed = z.array(shareholder).min(1).safeParse(shares.result);
    if (!parsed.success) throw new Error("股东账号响应不符合契约，请人工核对");
    await this.deps.save({
      ...pending,
      state: "ready",
      account: account.data,
      shareholders: parsed.data,
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
    const result = await this.request("/pt_web_qy_stock", {
      name: a.account!,
      yybid: "997376",
      type: "1",
    });
    const parsed = z
      .array(
        z
          .object({
            zqdm: z.string().regex(/^\d{6}$/),
            gpsl: numeric.pipe(z.number().int()),
            kysl: numeric.pipe(z.number().int()),
            gpcb: numeric,
          })
          .refine((p) => p.kysl <= p.gpsl),
      )
      .safeParse(result.data);
    if (!parsed.success) throw new Error("远程持仓格式无效，未覆盖本地账本");
    return parsed.data.map((p) => ({
      symbol: `${p.zqdm.startsWith("6") ? "sh" : /^[03]/.test(p.zqdm) ? "sz" : "bj"}${p.zqdm}`,
      quantity: p.gpsl,
      sellable: p.kysl,
      cost: p.gpcb,
    }));
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

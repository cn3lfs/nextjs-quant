import {
  cashDividendPlanSchema,
  type CashDividendPlan,
} from "~/lib/portfolio/cash-dividends";
type Event = CashDividendPlan["events"][number];
type Movement = {
  id: string;
  phase: "entitlement" | "receivable" | "payment";
  effectiveDate: string;
  bookedOn: string;
  shares: number;
  gross: number;
  tax: number;
  net: number;
};
const money = (v: number) => {
  const cents = Math.round(v * 100);
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error("分红金额超出安全范围");
  return cents / 100;
};
export class DividendLedger {
  readonly plan: CashDividendPlan;
  private states: {
    event: Event;
    shares?: number;
    gross: number;
    tax: number;
    net: number;
    recognized: boolean;
    paid: boolean;
  }[];
  private movements: Movement[] = [];
  private opened?: string;
  private closed?: string;
  constructor(input: CashDividendPlan) {
    this.plan = cashDividendPlanSchema.parse(input);
    this.states = this.plan.events.map((event) => ({
      event,
      gross: 0,
      tax: 0,
      net: 0,
      recognized: false,
      paid: false,
    }));
  }
  private capture(day: string, held: number, inclusive: boolean) {
    if (!Number.isSafeInteger(held) || held < 0)
      throw new Error("分红登记持仓非法");
    for (const state of this.states) {
      if (
        state.shares !== undefined ||
        !(inclusive ? state.event.record <= day : state.event.record < day)
      )
        continue;
      state.shares = held;
      state.gross = money(held * state.event.perShare);
      state.tax = money((state.gross * this.plan.taxBps) / 10000);
      state.net = money(state.gross - state.tax);
      this.movements.push({
        id: state.event.id,
        phase: "entitlement",
        effectiveDate: state.event.record,
        bookedOn: day,
        shares: held,
        gross: state.gross,
        tax: state.tax,
        net: state.net,
      });
    }
  }
  private settle(day: string, inclusive: boolean) {
    let cash = 0;
    for (const s of this.states) {
      if (s.shares === undefined) continue;
      if (!s.recognized && s.event.ex <= day) {
        s.recognized = true;
        this.movements.push({
          id: s.event.id,
          phase: "receivable",
          effectiveDate: s.event.ex,
          bookedOn: day,
          shares: s.shares,
          gross: s.gross,
          tax: s.tax,
          net: s.net,
        });
      }
      if (
        s.recognized &&
        !s.paid &&
        (inclusive ? s.event.pay <= day : s.event.pay < day)
      ) {
        s.paid = true;
        cash = money(cash + s.net);
        this.movements.push({
          id: s.event.id,
          phase: "payment",
          effectiveDate: s.event.pay,
          bookedOn: day,
          shares: s.shares,
          gross: s.gross,
          tax: s.tax,
          net: s.net,
        });
      }
    }
    return cash;
  }
  beforeOpen(day: string, held: number) {
    if (this.opened || (this.closed && day <= this.closed))
      throw new Error("分红账簿交易日顺序非法");
    this.opened = day;
    this.capture(day, held, false);
    return this.settle(day, false);
  }
  afterClose(day: string, held: number) {
    if (this.opened !== day) throw new Error("分红账簿缺少开盘阶段");
    this.capture(day, held, true);
    const cash = this.settle(day, true);
    this.opened = undefined;
    this.closed = day;
    return cash;
  }
  get receivable() {
    return money(
      this.states
        .filter((s) => s.recognized && !s.paid)
        .reduce((n, s) => n + s.net, 0),
    );
  }
  snapshot() {
    return {
      version: "dividend-ledger-1" as const,
      plan: structuredClone(this.plan),
      receivable: this.receivable,
      paid: money(
        this.states.filter((s) => s.paid).reduce((n, s) => n + s.net, 0),
      ),
      movements: this.movements.map((m) => ({ ...m })),
      assumptions: [
        "按登记日收盘后的模拟持仓确定资格；无该日行情时延用上一根模拟持仓，不证明真实交易日完整。",
        "除息日确认税后应收，派息日收盘阶段转现金，下一根开盘才可用于买入；缺失行情日的事件顺延到下个观测处理并保留原生效日期。",
        "每事件税前金额及固定实验税额分别四舍五入到分；税率为显式实验参数，不还原持有期差别化补税。",
      ],
    };
  }
}
export type DividendLedgerResult = ReturnType<DividendLedger["snapshot"]>;

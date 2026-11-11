import { z } from "zod";

export const marketAdmissionProfiles = {
  "AR01-time-window": "14:00–14:30主动建仓",
  "AR01-morning": "10:00–10:30主动建仓对照",
  "AR01-afternoon": "13:00–13:30主动建仓对照",
  "AR02-gain-filter": "盘中涨幅八成涨停幅度禁入",
  "AR03-st-filter": "历史非ST准入",
  "AR04-ipo-age": "上市满60交易日准入",
  "AR05-resumption": "复牌满3交易日准入",
  "AR06-report-window": "已知财报前后5交易日避让",
  "AR07-late-size": "晚入场递减仓位",
  "AR08-auction-confirm": "最终竞价结果确认后准入",
} as const;
export type MarketAdmissionId = keyof typeof marketAdmissionProfiles;
export const marketAdmissionIds = Object.keys(
  marketAdmissionProfiles,
) as MarketAdmissionId[];
export function isMarketAdmission(id: string): id is MarketAdmissionId {
  return Object.hasOwn(marketAdmissionProfiles, id);
}
const timestamp = z.string().datetime({ offset: true });
export const marketAdmissionInputSchema = z
  .object({
    symbol: z.string().regex(/^(sh|sz)\d{6}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().trim().min(1),
    version: z.string().trim().min(1),
    effectiveAt: timestamp,
    availableAt: timestamp,
    capturedAt: timestamp,
    limitFraction: z.number().positive().max(1).nullable().optional(),
    st: z.boolean().optional(),
    listedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    resumption: z
      .object({
        coverageComplete: z.literal(true),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .strict()
      .optional(),
    reports: z
      .object({
        coverageComplete: z.literal(true),
        windowStart: z.string(),
        windowEnd: z.string(),
        events: z.array(
          z.object({ date: z.string(), announcedAt: timestamp }).strict(),
        ),
      })
      .strict()
      .optional(),
    auction: z
      .object({
        stage: z.enum(["cancellable", "indicative", "final"]),
        observedAt: timestamp,
        price: z.number().finite().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const marketAdmissionInputsSchema = z
  .array(marketAdmissionInputSchema)
  .max(100000);
export type MarketAdmissionInput = z.infer<typeof marketAdmissionInputSchema>;
export const marketAdmissionBoundary =
  "AR工程v1，双突破已确认信号的主动建仓对照，5%止损及既有持有上限。时段在下一根open下单时检查：最佳[14:00,14:30)、次优[10:00,10:30)、一般[13:00,13:30)，三具名对照，不用未来信号重新排序。AR02以最新已完成5分钟close/昨收计算涨幅，>=当时真实limitFraction×0.8禁入（边界相等禁入），无涨跌幅限制时不可用；不把8%经验值称法定规则。AR03历史st=false；AR04上市日计第1交易日、>=60；AR05复牌日计第1交易日、>=3，无复牌须完整否定证据。AR06原文最近财报含糊，工程明确为当时已知前次披露及已公告未来日程前后5交易日（距离<=5禁入），要求覆盖当前前后5日的完整日历与公告窗口，不能以事后实际日期补入未来事件。AR07只在10:00后入场，14:00前风险/市值1倍，14:00–14:30半倍，14:30后四分之一；这是工程递减函数。AR08只接受当日09:25最终竞价结果且价格高于昨收，最早09:35下单；09:15可撤与09:20虚拟报价不作为正式信号，无历史竞价为待数据，不用首根五分钟close替代。除纯时段/递减外，逐证券逐日证据包含source/version/effectiveAt/availableAt/capturedAt；只消费已知版本，冲突版本不可用。成交仍受数量/涨跌停/费用/T+1约束。窗口2000-01-04..2022-11-30、逐日48根沿用原分钟引擎；未真实回测。";

export function marketAdmissionDecision(
  id: MarketAdmissionId,
  input: {
    symbol: string;
    date: string;
    at: string;
    previousClose: number;
    observedPrice: number | null;
    calendar: readonly string[];
    rows: readonly MarketAdmissionInput[];
  },
) {
  const time = input.at.slice(11, 16);
  const result = (
    allow: boolean,
    reason: string,
    multiplier = 1,
    status: "available" | "missing" = "available",
  ) => ({ allow, reason, multiplier, status });
  const inWindow = (from: string, to: string) => time >= from && time < to;
  if (id.startsWith("AR01")) {
    const window =
      id === "AR01-time-window"
        ? ["14:00", "14:30"]
        : id === "AR01-morning"
          ? ["10:00", "10:30"]
          : ["13:00", "13:30"];
    return result(
      inWindow(window[0]!, window[1]!),
      `主动建仓时段${window.join("–")}，左闭右开`,
    );
  }
  if (id === "AR07-late-size")
    return result(
      time >= "10:00",
      "晚入场风险及市值同步递减",
      time >= "14:30" ? 0.25 : time >= "14:00" ? 0.5 : 1,
    );
  const known = input.rows
    .filter(
      (r) =>
        r.symbol === input.symbol &&
        r.date === input.date &&
        Date.parse(r.effectiveAt) <= Date.parse(input.at) &&
        Date.parse(r.availableAt) <= Date.parse(input.at) &&
        Date.parse(r.availableAt) >= Date.parse(r.effectiveAt) &&
        Date.parse(r.capturedAt) >= Date.parse(r.availableAt),
    )
    .sort((a, b) => Date.parse(b.availableAt) - Date.parse(a.availableAt));
  const r = known[0];
  const missing = (reason: string) =>
    result(false, `待数据：${reason}`, 1, "missing");
  if (
    !r ||
    (known[1] && Date.parse(known[1].availableAt) === Date.parse(r.availableAt))
  )
    return missing("唯一历史时点状态");
  const current = input.calendar.indexOf(input.date);
  if (id === "AR02-gain-filter") {
    if (
      r.limitFraction == null ||
      input.observedPrice == null ||
      input.previousClose <= 0
    )
      return missing("历史涨停幅度与完成分钟价");
    return result(
      input.observedPrice <
        input.previousClose * (1 + 0.8 * r.limitFraction) - 1e-9,
      "当时涨幅小于真实涨停幅度的80%",
    );
  }
  if (id === "AR03-st-filter")
    return r.st === undefined
      ? missing("当日历史ST状态")
      : result(!r.st, "作者非ST经验过滤");
  if (id === "AR04-ipo-age") {
    const first = r.listedDate ? input.calendar.indexOf(r.listedDate) : -1;
    return first < 0 || current < first
      ? missing("上市日与完整交易日历")
      : result(current - first + 1 >= 60, "上市至少60交易日，上市日计1");
  }
  if (id === "AR05-resumption") {
    if (!r.resumption) return missing("历史停复牌完整状态");
    if (r.resumption.date === null)
      return result(true, "完整证据确认没有复牌事件");
    const first = input.calendar.indexOf(r.resumption.date);
    return first < 0 || current < first
      ? missing("复牌日历")
      : result(current - first + 1 >= 3, "复牌至少3交易日，复牌日计1");
  }
  if (id === "AR06-report-window") {
    const reports = r.reports;
    if (
      !reports ||
      current < 5 ||
      current + 5 >= input.calendar.length ||
      reports.windowStart > input.calendar[current - 5]! ||
      reports.windowEnd < input.calendar[current + 5]!
    )
      return missing("财报前后五日完整已知日程/日历覆盖");
    if (
      reports.events.some(
        (e) =>
          Date.parse(e.announcedAt) > Date.parse(input.at) ||
          input.calendar.indexOf(e.date) < 0,
      )
    )
      return missing("财报日期的首次可知时点或日历");
    return result(
      !reports.events.some(
        (e) => Math.abs(input.calendar.indexOf(e.date) - current) <= 5,
      ),
      "已知前次/未来财报距离严格大于5交易日",
    );
  }
  const auction = r.auction;
  if (
    !auction ||
    auction.stage !== "final" ||
    auction.observedAt !== `${input.date}T09:25:00+08:00` ||
    Date.parse(r.availableAt) < Date.parse(auction.observedAt)
  )
    return missing("当日09:25最终竞价结果，无lc1/竞价不可补造");
  return result(
    time >= "09:35" && auction.price > input.previousClose,
    "最终竞价高于昨收，延后至09:35下单",
  );
}

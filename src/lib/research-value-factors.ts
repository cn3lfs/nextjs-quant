import { z } from "zod";
import type { AsOfDomain } from "./as-of";
import {
  valueQualitySchema,
  valueGuoSchema,
  valueRiskSchema,
  valueMarketSchema,
  valuePolicySchema,
  valueGovernanceSchema,
  valueThesisSchema,
  valueThesisObservationSchema,
} from "./as-of-inputs";
import { calculateValuation } from "./valuation";

export const valueFactorRules: Record<string, string> = {
  FA01: "九项F-Score；>=6为工程质量筛选，零/等号不算改善",
  FA02: "三年DuPont与行业对照，利润率和周转共同改善且杠杆不升为工程准入",
  FA03: "三年已核验FCFF均值、预先冻结CAPM/WACC、五年+2%永续，增长±1%三情景中位；折价>=20%",
  FA04: "行业PE/PB/PS/EV-EBITDA与五年历史比，PE隐含公允价折价>=10%；亏损不套PE",
  FA05: "固定周年采样的五年估值窗口工程版，PE/PB严格更低者百分位<20；并列不拆，缺口不补",
  FA06: "Graham EPS*(8.5+2g)*4.4/Y，g限制0至15%，持续盈利，价格严格<67%",
  FA07: "TTM PE/预先冻结一年盈利增长百分数，PE与增长均正，PEG<=1；非正不可用",
  FA08: "六维20/20/20/15/15/10%，区间中点和边界具名工程版，完整输入且>=65",
  FA09: "DCF/行业PE/历史PE/Graham/PEG 30/25/15/20/10%，全部模型有效且折价>=20%；不因缺失重分权重",
  GY01: "五年利润/OCF累计比例<.5或连续3年非正+正利润为排雷代理，九类未解释危险硬否决；高弹性行业加严比例1",
  GY02: "重构资产/有息资本、无效商誉研发剔除、五年股权价值增加>0；长期融资净值非负",
  GY03: "OCF五状态；近零/近非付现成本为冻结1%尺度工程定义；状态5准入，状态4只显示无增长不入场",
  GY04: "七项保全性成本FCF，独立于全部资本支出及标准FCFF；正值筛选",
  GY05: "郭永清独立股权8%/七折安全边际，排雷/重构/现金流门槛完整组合；不调用标准DCF口径",
  GY06: "行业路由单独注册，专用现金流先于周期5至10年均值；完整七步工程组合与单组件分开",
  "GY06-bank":
    "五年银行现金流减贷款投资资产额外1%减值，每股均值/.08，七折；无常规资产资本表",
  "GY06-research":
    "OCF加回当年研发，减min(当年,上年)研发保全与其他保全；不重复扣研发",
  "GY06-long-asset":
    "5至10年披露维护或事前登记历史低位capex近似，禁止折旧直接替代",
  "GY06-cycle": "先行业现金流再5至10年均值，终值增速0至2%，保留冻结周期位置",
  "GY06-growth": "OCF减保全加回较基期增加的扩张营运现金，至少3年且逐期披露",
  "GY06-property":
    "开发项目简化NAV=货值-剩余成本-税费-债务，七折；不混用DCF，非REIT",
  VI01: "冻结生意/护城河与现金转换假设、触发/失效/最长等待",
  VI02: "冻结每股增长/再投资回报假设，不用规模增长冒充每股价值",
  VI03: "冻结市场隐含与保守增长的分歧假设，要求证据与兑现期",
  VI04: "冻结暂时压力/恢复进展假设，永久损伤独立否决",
  VI05: "冻结永久损伤/治理恶化退出假设，失效优先且不因价格便宜撤销",
  VI06: "冻结上行/永久损失不对称假设与折价，不冒充实测概率",
  VI07: "冻结持有/估值要求/替代机会再平衡，失效或持有期限退出",
  "VI08-horizon": "冻结市场期限与投入形成优势的证据，时间错配不能替亏损辩护",
  "VI08-categorization": "冻结业务结构变化/旧标签依赖与失效条件",
  "VI08-coverage": "冻结低覆盖与证据完整性双条件，冷门自身不构成优势",
  "VI08-liquidity": "冻结被迫抛售与资金期限，永久损伤否决，不推断真实资金流",
};
export const valueThesisMetrics: Record<string, string[]> = {
  VI01: ["moatRetention", "ownerCashConversion"],
  VI02: ["perShareGrowth", "reinvestmentReturn"],
  VI03: ["marketRequiredGrowth", "conservativeGrowth"],
  VI04: ["temporaryStress", "recoveryProgress"],
  VI05: ["permanentDamage", "governanceDamage"],
  VI06: ["downsideLossPct", "upsidePct"],
  VI07: ["valuationDemand", "alternativeAdvantage"],
  "VI08-horizon": ["marketHorizonYears", "investmentPayoffEvidence"],
  "VI08-categorization": ["businessMixChange", "oldLabelDependence"],
  "VI08-coverage": ["coverageCount", "evidenceCompleteness"],
  "VI08-liquidity": ["forcedSelling", "fundingYears"],
};
const ensure = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};
const sum = (r: Record<string, number>) =>
  Object.values(r).reduce((n, v) => n + v, 0);
const mean = (v: number[]) => v.reduce((n, x) => n + x / v.length, 0);
const bounded = (n: number) => Math.max(0, Math.min(100, n));
const finite = (n: number) => {
  ensure(Number.isFinite(n), "算术结果非有限数");
  return n;
};
type Request = {
  observationDate: string;
  asOf: string;
  annualPeriods: string[];
};
type Reader = (domain: AsOfDomain, field: string, at: string) => unknown;
export function valueFactorInputs(
  id: string,
  req: Request,
): { domain: AsOfDomain; field: string; effectiveAt: string }[] {
  const fields: string[] = id.startsWith("VI")
    ? ["valueTheses", "valueThesisObservations"]
    : id === "FA01"
      ? []
      : id === "FA02" || id === "FA04" || id === "FA05"
        ? ["valueMarket"]
        : id === "GY03" || id === "GY04"
          ? []
          : id === "GY01"
            ? ["valueRisk"]
            : id === "GY02"
              ? ["valueRisk", "valuePolicy"]
              : id.startsWith("GY")
                ? ["valueRisk", "valuePolicy", "valueMarket"]
                : [
                    "valueMarket",
                    "valuePolicy",
                    ...(["FA08", "FA09"].includes(id) ? ["valueRisk"] : []),
                    ...(id === "FA08" ? ["valueGovernance"] : []),
                  ];
  const out: { domain: AsOfDomain; field: string; effectiveAt: string }[] =
    fields.map((field) => ({
      domain: "capital",
      field,
      effectiveAt: req.observationDate,
    }));
  if (!id.startsWith("VI")) {
    const n =
      id === "FA01"
        ? 2
        : id === "GY03" || id === "GY04"
          ? 1
          : id.startsWith("GY") || ["FA08", "FA09"].includes(id)
            ? 5
            : 3;
    for (const effectiveAt of [...req.annualPeriods]
      .sort()
      .reverse()
      .slice(0, n))
      out.push({
        domain: "finance",
        field: id.startsWith("GY") ? "annualGuo" : "annualValueQuality",
        effectiveAt,
      });
    if (["FA03", "FA08", "FA09"].includes(id))
      for (const effectiveAt of [...req.annualPeriods]
        .sort()
        .reverse()
        .slice(0, 3))
        out.push({ domain: "finance", field: "annualFcff", effectiveAt });
  }
  return out;
}
/** Method arithmetic only. The caller supplies the existing B6a read, evidence and gap collector. */
export function evaluateValueFactor(id: string, req: Request, read: Reader) {
  let participation: "rule" | "human" | "llm" = "rule";
  const at = req.observationDate;
  const take = (field: string) => read("capital", field, at);
  const result = (
    passed: boolean,
    details: Record<string, unknown>,
    points = Number(passed),
  ) => ({
    points: finite(points),
    details: {
      buyEligible: passed,
      executionBoundary:
        "待数据候选；月末观察、下一合法成交时点、风险1.5%/单股25%、质量恶化或估值修复退出、最长持有365日工程对照；未撮合",
      ...details,
    },
    participation,
  });
  if (id.startsWith("VI")) {
    const theses = z.array(valueThesisSchema).parse(take("valueTheses"));
    const thesis = theses.find((t) => t.methodId === id);
    ensure(!!thesis, "缺该方法冻结假设");
    const t = thesis!;
    ensure(
      Date.parse(t.frozenAt) < Date.parse(req.asOf) &&
        Date.parse(t.recordedAt) <= Date.parse(t.frozenAt) &&
        Date.parse(t.evidenceCutoff) <= Date.parse(t.frozenAt),
      "假设/证据/档案必须在决策前真实冻结，不允许历史角色扮演",
    );
    ensure(
      t.start <= at &&
        Date.parse(t.frozenAt) <= Date.parse(`${t.start}T00:00:00+08:00`),
      "假设须在等待期开始前冻结",
    );
    if (t.origin === "llm")
      ensure(!!t.modelVersion && !!t.promptHash, "LLM版本和提示词hash缺失");
    participation = t.origin;
    const observations = z
      .record(z.string(), valueThesisObservationSchema)
      .parse(take("valueThesisObservations"));
    const o = observations[id];
    ensure(!!o && o.thesisVersion === t.version, "观察与冻结假设版本不一致");
    const data = o!;
    ensure(
      Date.parse(data.recordedAt) <= Date.parse(req.asOf) &&
        Date.parse(data.evidenceCutoff) <= Date.parse(data.recordedAt),
      "观察证据生成时间晚于决策，禁止事后生成历史判断",
    );
    if (data.origin === "llm")
      ensure(
        !!data.modelVersion && !!data.promptHash,
        "LLM观察缺模型/提示词版本",
      );
    participation =
      t.origin === "llm" || data.origin === "llm"
        ? "llm"
        : t.origin === "human" || data.origin === "human"
          ? "human"
          : "rule";
    const used = new Set(
      [...t.triggers, ...t.invalidations].map((p) => p.metric),
    );
    ensure(
      valueThesisMetrics[id]!.every((k) =>
        (id === "VI05" ? t.invalidations : t.triggers).some(
          (p) => p.metric === k,
        ),
      ) && used.has("permanentDamage"),
      "方法专属触发指标或永久损伤失效条件缺失",
    );
    ensure(
      t.invalidations.some((p) => p.metric === "permanentDamage"),
      "永久损伤必须为失效条件",
    );
    ensure(
      [...used].every(
        (k) =>
          typeof data.metrics[k] === "number" &&
          Number.isFinite(data.metrics[k]),
      ),
      "冻结条件依赖的观察指标缺失，不填零",
    );
    const check = (p: (typeof t.triggers)[number]) =>
      p.op === "gte"
        ? data.metrics[p.metric]! >= p.threshold
        : data.metrics[p.metric]! <= p.threshold;
    const invalid = t.invalidations.some(check);
    const economics =
      id === "VI03"
        ? data.metrics.conservativeGrowth! > data.metrics.marketRequiredGrowth!
        : id === "VI06"
          ? data.metrics.upsidePct! > data.metrics.downsideLossPct! &&
            data.metrics.downsideLossPct! >= 0
          : id === "VI08-horizon"
            ? data.metrics.marketHorizonYears! < t.maxHoldingDays / 365
            : true;
    const trigger = t.triggers.every(check) && economics;
    const elapsed = (Date.parse(at) - Date.parse(t.start)) / 86400000;
    ensure(
      data.enteredAt === null ||
        (data.enteredAt >= t.start && data.enteredAt <= at),
      "持仓起点不在冻结研究期内",
    );
    const held =
      data.enteredAt === null
        ? 0
        : (Date.parse(at) - Date.parse(data.enteredAt)) / 86400000;
    const expired = elapsed > t.maxWaitDays,
      holdExpired = data.enteredAt !== null && held >= t.maxHoldingDays;
    const margin = 1 - data.price / t.fairValue;
    const sell = invalid || holdExpired || data.price >= t.fairValue;
    const buy =
      id !== "VI05" &&
      !sell &&
      !expired &&
      trigger &&
      margin >= t.entryDiscount &&
      data.positionPct < Math.min(25, t.maxPositionPct);
    return result(buy, {
      thesis: t,
      trigger,
      invalid,
      expired,
      holdExpired,
      margin,
      action: sell
        ? "exit"
        : data.positionPct > Math.min(25, t.maxPositionPct)
          ? "reduce"
          : buy
            ? "candidate"
            : data.enteredAt !== null
              ? "hold"
              : "wait",
      targetPositionPct: sell ? 0 : Math.min(25, t.maxPositionPct),
      statisticsGroup: `${id}:${participation}:${t.version}:${data.measurementVersion}`,
      executionBoundary:
        "冻结假设候选/退出；下一合法成交时点、风险1.5%/单股min(25%,冻结上限)，等待期/持有期取自假设；只离线研究",
    });
  }
  const years = [...req.annualPeriods].sort().reverse();
  const annual = (field: string, n: number) => {
    ensure(
      years.length >= n &&
        years
          .slice(0, n)
          .every(
            (d, i) =>
              !i ||
              Number(years[i - 1]!.slice(0, 4)) - Number(d.slice(0, 4)) === 1,
          ),
      `需要${n}个连续年报及各自可信披露日`,
    );
    return years.slice(0, n).map((date) => read("finance", field, date));
  };
  const policy = () => {
    const p = valuePolicySchema.parse(take("valuePolicy"));
    ensure(
      Date.parse(p.frozenAt) < Date.parse(req.asOf),
      "估值模型参数必须在决策前冻结",
    );
    if (p.origin === "human") participation = "human";
    return p;
  };
  const market = () => {
    const m = valueMarketSchema.parse(take("valueMarket"));
    ensure(m.history.end === at, "估值历史末端不等于观察日/含未来");
    const start = new Date(`${at}T00:00:00Z`);
    start.setUTCFullYear(start.getUTCFullYear() - 5);
    ensure(
      m.history.start === start.toISOString().slice(0, 10) &&
        m.history.rows.length === 6 &&
        m.history.rows.every(
          (r, i) =>
            r.date === `${Number(at.slice(0, 4)) - 5 + i}${at.slice(4)}`,
        ),
      "缺完整五年周年采样窗口，不能跳过年度",
    );
    ensure(
      Math.abs(m.price / m.bps - m.history.rows.at(-1)!.pb) < 1e-8 &&
        (m.epsTtm <= 0 ||
          Math.abs(m.price / m.epsTtm - m.history.rows.at(-1)!.pe) < 1e-8),
      "末端PE/PB与当前价格口径不一致",
    );
    return m;
  };
  const risks = () => {
    const r = valueRiskSchema.parse(take("valueRisk"));
    if (r.origin === "human") participation = "human";
    return r;
  };
  const guo = id.startsWith("GY");
  if (!guo) {
    const q = annual(
      "annualValueQuality",
      id === "FA01" ? 2 : ["FA08", "FA09"].includes(id) ? 5 : 3,
    ).map((v) => valueQualitySchema.parse(v));
    const c = q[0]!,
      p = q[1]!;
    const roa = (x: typeof c) => x.netIncome / x.assets;
    const margin = (x: typeof c) => x.netIncome / x.revenue;
    const gross = (x: typeof c) => x.grossProfit / x.revenue;
    const turnover = (x: typeof c) => x.revenue / x.assets;
    const leverage = (x: typeof c) => x.assets / x.equity;
    const roe = (x: typeof c) => (x.netIncome / x.equity) * 100;
    if (id === "FA01") {
      const checks = [
        roa(c) > 0,
        c.operatingCashFlow > 0,
        roa(c) > roa(p),
        c.operatingCashFlow > c.netIncome,
        c.longDebt / c.assets < p.longDebt / p.assets,
        c.currentAssets / c.currentLiabilities >
          p.currentAssets / p.currentLiabilities,
        c.issuedShares === 0,
        gross(c) > gross(p),
        turnover(c) > turnover(p),
      ];
      const score = checks.filter(Boolean).length;
      return result(
        score >= 6,
        { checks, score, exitEligible: score < 6 },
        score,
      );
    }
    let financialVeto = false;
    if (["FA08", "FA09"].includes(id)) {
      const risk = risks(),
        income = q.reduce((n, x) => n + x.netIncome, 0),
        cash = q.reduce((n, x) => n + x.operatingCashFlow, 0);
      financialVeto =
        Object.values(risk.flags).some((x) => x.hit && !x.explanation) ||
        (income > 0 &&
          (cash / income < (risk.flexibleAccounting ? 1 : 0.5) ||
            q.slice(0, 3).every((x) => x.operatingCashFlow <= 0)));
      if (financialVeto)
        return result(false, {
          exitEligible: true,
          veto: true,
          reason: "排雷硬否决，不继续估值评分",
        });
    }
    if (q.length > (id === "FA08" ? 4 : 3)) q.splice(id === "FA08" ? 4 : 3); // Five years are required for risk, scoring uses the latest three.
    const m = market();
    if (id === "FA02") {
      const decomposition = q.map((x) => ({
        netMargin: margin(x),
        turnover: turnover(x),
        multiplier: leverage(x),
        roe: margin(x) * turnover(x) * leverage(x) * 100,
      }));
      const improved = decomposition
        .slice(0, -1)
        .every(
          (x, i) =>
            x.netMargin > decomposition[i + 1]!.netMargin &&
            x.turnover > decomposition[i + 1]!.turnover &&
            x.multiplier <= decomposition[i + 1]!.multiplier,
        );
      return result(
        improved &&
          margin(c) >= m.industry.netMargin &&
          turnover(c) >= m.industry.turnover,
        {
          exitEligible: !improved,
          decomposition,
          industry: m.industry,
          leverageDriven: roe(c) > roe(p) && leverage(c) > leverage(p),
        },
        roe(c),
      );
    }
    if (id === "FA05") {
      const pe = m.price / m.epsTtm,
        pb = m.price / m.bps;
      ensure(m.epsTtm > 0, "亏损/零盈利PE不可用");
      const percentile = (key: "pe" | "pb", v: number) =>
        (m.history.rows.filter((x) => x[key] < v).length /
          m.history.rows.length) *
        100;
      const pePct = percentile("pe", pe),
        pbPct = percentile("pb", pb);
      return result(
        pePct < 20 && pbPct < 20,
        {
          exitEligible: pePct >= 50 || pbPct >= 50,
          pePct,
          pbPct,
          window: {
            start: m.history.start,
            end: m.history.end,
            count: m.history.rows.length,
          },
        },
        100 - Math.max(pePct, pbPct),
      );
    }
    if (id === "FA04") {
      ensure(m.epsTtm > 0, "亏损公司PE不适用，不能静默转为另一模型");
      const values = {
        pe: m.price / m.epsTtm,
        pb: m.price / m.bps,
        ps: m.price / m.salesPerShare,
        evEbitda: m.evEbitda,
      };
      const comparisons = Object.entries(values).map(([k, v]) => ({
        metric: k,
        industryPremiumPct:
          (v / m.industry[k as keyof typeof values] - 1) * 100,
        historicalPremiumPct:
          (v / mean(m.history.rows.map((x) => x[k as keyof typeof values])) -
            1) *
          100,
      }));
      const fair = m.epsTtm * m.industry.pe;
      return result(
        m.price <= fair * 0.9,
        { exitEligible: m.price >= fair, comparisons, fair },
        (1 - m.price / fair) * 100,
      );
    }
    const pol = policy();
    const growth =
      Math.max(
        0,
        Math.min(pol.expectedGrowthPct, Math.max(0, 2 * pol.industryGrowthPct)),
      ) / 100;
    const wacc =
      (pol.marketEquity * (pol.riskFreeRate + pol.beta * pol.equityPremium) +
        pol.interestDebt * pol.debtCost * (1 - pol.taxRate)) /
      (pol.marketEquity + pol.interestDebt);
    const dcf = () => {
      const fcff = annual("annualFcff", 3).map((v) =>
        z.number().finite().parse(v),
      );
      ensure(wacc > 0.02, "WACC必须高于2%永续；禁止替换分母");
      const values = [growth - 0.01, growth, growth + 0.01].map(
        (g) =>
          calculateValuation({
            method: "fcff-wacc",
            cashFlowBasis: "fcff",
            currency: "CNY",
            amountUnit: "yuan",
            sharesUnit: "shares",
            totalShares: c.shares,
            growthRate: g,
            discountRate: wacc,
            terminalGrowthRate: 0.02,
            assumptionNote: pol.evidence,
            forecastYears: 5,
            baseFcff: mean(fcff),
            cashAndNonOperatingAssets: pol.cashNonOperating,
            debtValue: pol.interestDebt,
            minorityInterestValue: pol.minorityClaims,
            otherClaimsValue: pol.otherClaims,
          }).perShareValue,
      );
      return {
        values,
        fair: [...values].sort((a, b) => a - b)[1]!,
        wacc,
        growth,
        baseFcff: mean(fcff),
        model: "historical-fcff-wacc-frozen",
      };
    };
    const graham = () => {
      ensure(
        q.every((x) => x.netIncome > 0) && m.epsTtm > 0,
        "Graham需要持续正盈利",
      );
      return (
        (m.epsTtm *
          (8.5 + 2 * Math.max(0, Math.min(15, pol.expectedGrowthPct))) *
          4.4) /
        pol.aaaYieldPct
      );
    };
    const peg = () => {
      ensure(
        m.epsTtm > 0 && pol.expectedGrowthPct > 0,
        "PEG负盈利或非正增长不适用",
      );
      return m.price / m.epsTtm / pol.expectedGrowthPct;
    };
    if (id === "FA03") {
      const v = dcf();
      ensure(v.fair > 0, "标准DCF归母价值非正");
      return result(
        m.price <= v.fair * 0.8,
        { ...v, exitEligible: m.price >= v.fair },
        (1 - m.price / v.fair) * 100,
      );
    }
    if (id === "FA06") {
      const fair = graham();
      return result(
        m.price < fair * 0.67,
        {
          exitEligible: m.price >= fair,
          fair,
          growthPct: Math.max(0, Math.min(15, pol.expectedGrowthPct)),
        },
        (1 - m.price / fair) * 100,
      );
    }
    if (id === "FA07") {
      const ratio = peg();
      return result(
        ratio <= 1,
        {
          exitEligible: ratio >= 1.5,
          peg: ratio,
          growthPct: pol.expectedGrowthPct,
        },
        1 / ratio,
      );
    }
    const models = [
      dcf().fair,
      m.industry.pe * m.epsTtm,
      mean(m.history.rows.map((x) => x.pe)) * m.epsTtm,
      graham(),
      m.epsTtm * pol.expectedGrowthPct,
    ];
    peg();
    ensure(
      models.every((v) => v > 0 && Number.isFinite(v)),
      "五模型不可用，不重新分配缺失权重",
    );
    const fair = models.reduce(
        (n, v, i) => n + v * [0.3, 0.25, 0.15, 0.2, 0.1][i]!,
        0,
      ),
      mos = 1 - m.price / fair;
    if (id === "FA09")
      return result(
        mos >= 0.2,
        {
          exitEligible: mos <= 0,
          models,
          weights: [0.3, 0.25, 0.15, 0.2, 0.1],
          fair,
          margin: mos,
        },
        mos * 100,
      );
    const gov = valueGovernanceSchema.parse(take("valueGovernance")),
      risk = risks();
    const govStart = new Date(`${at}T00:00:00Z`);
    govStart.setUTCMonth(govStart.getUTCMonth() - 6);
    ensure(
      gov.windowEnd === at &&
        gov.windowStart === govStart.toISOString().slice(0, 10),
      "治理指标必须覆盖冻结六个月窗口",
    );
    if (gov.origin === "human") participation = "human";
    const veto = Object.values(risk.flags).some((x) => x.hit && !x.explanation);
    const incomePositive = q.every((x) => x.netIncome > 0),
      cashRatios = q.map((x) =>
        x.netIncome > 0 ? x.operatingCashFlow / x.netIncome : null,
      );
    const cagr = (c.revenue / q.at(-1)!.revenue) ** (1 / (q.length - 1)) - 1;
    const profitGrowth = p.netIncome > 0 ? c.netIncome / p.netIncome - 1 : null;
    ensure(profitGrowth !== null, "六维盈利增长非正基数不可用");
    const up = q.slice(0, -1).every((x, i) => roe(x) > roe(q[i + 1]!)),
      down = q.slice(0, -1).every((x, i) => roe(x) < roe(q[i + 1]!));
    const gm = gross(c) * 100,
      stable = q.every((x) => Math.abs(gross(x) - gross(c)) <= 0.05);
    // Source gives ranges, not interpolation: frozen midpoint 90/69.5/49.5/29.5/9.5.
    const base = (level: number) => [9.5, 29.5, 49.5, 69.5, 90][level]!;
    const profitability = bounded(
      base(
        roe(c) > 20
          ? 4
          : roe(c) >= 15
            ? 3
            : roe(c) >= 10
              ? 2
              : roe(c) >= 5
                ? 1
                : 0,
      ) +
        (up ? 10 : down ? -10 : 0) +
        (incomePositive && cashRatios.every((v) => v! > 1)
          ? 10
          : incomePositive && cashRatios.every((v) => v! < 0.8)
            ? -10
            : 0) +
        (q.every((x) => gross(x) > 0.4) ? 5 : 0),
    );
    const growthScore = bounded(
      base(
        cagr > 0.2 ? 4 : cagr >= 0.1 ? 3 : cagr >= 0.05 ? 2 : cagr >= 0 ? 1 : 0,
      ) +
        (profitGrowth! > cagr ? 10 : cagr > 0 && profitGrowth! <= 0 ? -10 : 0) +
        (q.slice(0, -1).every((x, i) => x.revenue > q[i + 1]!.revenue)
          ? 5
          : 0) -
        (gov.acquisitionDriven ? 5 : 0),
    );
    const debtPct = (c.liabilities / c.assets) * 100,
      cr = c.currentAssets / c.currentLiabilities,
      cover = c.ebit / c.interestExpense;
    const health = bounded(
      base(
        debtPct < 30
          ? 4
          : debtPct < 50
            ? 3
            : debtPct < 70
              ? 2
              : debtPct <= 85
                ? 1
                : 0,
      ) +
        (cr > 2 ? 10 : cr < 1 ? -10 : 0) +
        (cover > 5 ? 10 : cover < 2 ? -10 : 0) +
        (pol.interestDebt > 0 &&
        (c.operatingCashFlow - c.capex) / pol.interestDebt > 0.3
          ? 5
          : 0) -
        (q.every((x) => x.operatingCashFlow < 0) ? 15 : 0),
    );
    const competition = bounded(
      base(
        gm > 50 && stable
          ? 4
          : gm >= 30 && stable
            ? 3
            : gm >= 20
              ? 2
              : gm >= 10
                ? 1
                : 0,
      ) +
        (gov.marketRank > 0 && gov.marketRank <= 3 ? 15 : 0) -
        (gov.customerConcentrationPct > 50 ? 15 : 0) +
        (gov.diversified ? 10 : 0) +
        (gross(c) > gross(p) ? 5 : gross(c) < gross(p) ? -10 : 0),
    );
    const roic = (c.ebit * (1 - c.taxRate)) / c.investedCapital;
    const management = bounded(
      50 +
        (gov.insiderNetChangePct > 0
          ? 20
          : gov.insiderNetChangePct < -5
            ? -20
            : 0) +
        (q.every((x) => x.dividendPerShare > 0) ? 10 : -5) +
        (gov.regulatoryLetters === 0 ? 10 : -20) +
        (roic > wacc ? 15 : roic < wacc ? -15 : 0) +
        (gov.pledgePct < 10 ? 5 : gov.pledgePct > 30 ? -10 : 0),
    );
    const deviation = mean(models.map((v) => (1 - m.price / v) * 100));
    const valuation = base(
      deviation > 30
        ? 4
        : deviation >= 15
          ? 3
          : deviation >= -15
            ? 2
            : deviation >= -30
              ? 1
              : 0,
    );
    const dimensions = [
        profitability,
        growthScore,
        health,
        competition,
        management,
        valuation,
      ],
      score = dimensions.reduce(
        (n, v, i) => n + v * [0.2, 0.2, 0.2, 0.15, 0.15, 0.1][i]!,
        0,
      );
    return result(
      !veto && score >= 65,
      {
        exitEligible: veto || score < 45,
        dimensions,
        score,
        veto,
        models,
        scoringVersion: "source-range-midpoint-1",
        cashRatios,
        continuousYears: q.length,
      },
      score,
    );
  }
  const n = id === "GY03" || id === "GY04" ? 1 : 5;
  const rows = annual("annualGuo", n).map((v) => valueGuoSchema.parse(v)),
    c = rows[0]!;
  const maintenance = (r: typeof c) => sum(r.maintenance);
  const cashState = (r: typeof c) => {
    const cost = maintenance(r),
      tol = Math.max(1, Math.abs(cost)) * 0.01;
    return r.ocf < -tol
      ? 1
      : Math.abs(r.ocf) <= tol
        ? 2
        : r.ocf < cost - tol
          ? 3
          : Math.abs(r.ocf - cost) <= tol
            ? 4
            : 5;
  };
  if (id === "GY03") {
    const state = cashState(c);
    return result(
      state === 5,
      {
        exitEligible: state < 5,
        state,
        ocf: c.ocf,
        noncash: maintenance(c),
        tolerance: Math.max(1, maintenance(c)) * 0.01,
        noGrowth: state === 4,
      },
      state,
    );
  }
  if (id === "GY04") {
    const cost = maintenance(c),
      fcf = c.ocf - cost;
    return result(
      fcf > 0,
      {
        exitEligible: fcf <= 0,
        fcf,
        maintenance: cost,
        fullCapexFcf: c.ocf - c.capex,
      },
      fcf,
    );
  }
  const risk = risks();
  const earnings = sum(
      Object.fromEntries(rows.map((r, i) => [i, r.netIncome])),
    ),
    cash = sum(Object.fromEntries(rows.map((r, i) => [i, r.ocf])));
  const divergent =
    earnings > 0 &&
    (cash / earnings < (risk.flexibleAccounting ? 1 : 0.5) ||
      rows.slice(0, 3).every((r) => r.ocf <= 0));
  const flags = Object.entries(risk.flags)
    .filter(([, v]) => v.hit && !v.explanation)
    .map(([k]) => k);
  const safe = !divergent && !flags.length;
  if (id === "GY01")
    return result(safe, {
      exitEligible: !safe,
      divergent,
      flags,
      earnings,
      cash,
      years: years.slice(0, 5),
    });
  const pol = policy();
  const reconstruct = (r: typeof c) => {
    const financial = sum(r.financial) - 2 * r.financial.restrictedCash!;
    const working = sum(r.workingAssets) - sum(r.workingLiabilities);
    const goodwillDeduction =
      pol.standardProduct || pol.acquiredBusinessYears < 5
        ? r.longAssets.goodwill!
        : 0;
    const researchDeduction = pol.exclusiveResearchPricing
      ? 0
      : r.longAssets.development!;
    const longAssets =
      sum(r.longAssets) - goodwillDeduction - researchDeduction;
    const equity = r.equity - goodwillDeduction - researchDeduction;
    ensure(equity > 0, "剔除无效资产后权益非正");
    const capital = r.shortDebt + r.longDebt + equity;
    const assetTotal =
      financial +
      r.financial.restrictedCash! +
      working +
      longAssets +
      r.investmentBook;
    ensure(
      Math.abs(assetTotal - capital) <= Math.max(1, Math.abs(capital)) * 1e-8,
      "资产资本重构不配平，缺分类科目或重复计量；不补差额继续估值",
    );
    const longFinancing =
      r.longDebt +
      equity -
      longAssets -
      r.investmentBook -
      Math.max(0, working);
    const ebit = r.operatingEbit;
    ensure(ebit !== 0 && r.preTaxProfit !== 0, "五因素分母为零");
    const factors = [
      ebit / r.revenue,
      r.revenue / capital,
      r.preTaxProfit / ebit,
      capital / equity,
      r.netIncome / r.preTaxProfit,
    ];
    return {
      financial,
      working,
      longAssets,
      equity,
      capital,
      assetTotal,
      longFinancing,
      goodwillDeduction,
      researchDeduction,
      debtRate: (r.shortDebt + r.longDebt) / capital,
      leverage: capital / equity,
      equityAdded: r.netIncome - equity * 0.08,
      roeFactors: factors,
      roe: factors.reduce((a, b) => a * b, 1),
    };
  };
  const reconstruction =
    pol.industry === "bank" || pol.industry === "property"
      ? []
      : rows.map(reconstruct);
  if (id === "GY02")
    ensure(reconstruction.length > 0, "银行/地产不使用常规资产资本表");
  if (id === "GY02")
    return result(
      reconstruction.every((r) => r.equityAdded > 0) &&
        reconstruction[0]!.longFinancing >= 0,
      {
        exitEligible:
          reconstruction[0]!.equityAdded <= 0 ||
          reconstruction[0]!.longFinancing < 0,
        reconstruction,
      },
      reconstruction[0]!.equityAdded,
    );
  const m = market();
  const requested = id.startsWith("GY06-") ? id.slice(5) : pol.industry;
  if (id.startsWith("GY06-"))
    ensure(
      requested === pol.industry || (requested === "cycle" && pol.cycle),
      "行业专用方法不适用于该冻结行业",
    );
  const branch = requested === "cycle" ? pol.industry : requested;
  const fcfFor = (r: typeof c, i: number) => {
    if (branch === "bank")
      return (
        r.bank.interestFeesReceived +
        r.bank.investmentCash -
        r.bank.payroll -
        r.bank.taxes -
        r.bank.feesPaid -
        maintenance(r) -
        0.01 * (r.bank.loanAssets + r.bank.investmentAssets)
      );
    if (branch === "research") {
      const prior = rows[i + 1];
      ensure(!!prior, "研发口径缺上年研发现金");
      return (
        r.ocf +
        r.researchCash -
        Math.min(r.researchCash, prior!.researchCash) -
        maintenance(r)
      );
    }
    if (branch === "long-asset") {
      let cost = r.maintenanceActual;
      if (pol.longMaintenanceMode === "historical-low")
        cost = Math.min(...rows.map((x) => x.capex));
      else
        ensure(
          cost !== null && !!r.maintenanceEvidence,
          "缺长寿命资产维护拆分证据，不用折旧替代",
        );
      return r.ocf - cost!;
    }
    if (branch === "growth")
      return (
        r.ocf -
        maintenance(r) +
        Math.max(0, r.expansionWorkingCash - rows.at(-1)!.expansionWorkingCash)
      );
    return r.ocf - maintenance(r);
  };
  let fair: number,
    baseFcf: number | null = null,
    valuation: unknown = null;
  if (branch === "property") {
    ensure(
      pol.projects.length > 0 &&
        new Set(pol.projects.map((p) => p.id)).size === pol.projects.length,
      "缺地产项目或项目重复",
    );
    fair =
      (pol.projects.reduce(
        (v, p) => v + p.saleableValue - p.remainingCost - p.taxes,
        0,
      ) -
        pol.propertyDebt) /
      c.shares;
    valuation = {
      model: "simplified-project-nav",
      projects: pol.projects,
      debt: pol.propertyDebt,
    };
  } else if (branch === "bank") {
    const perShare = rows.map((r, i) => fcfFor(r, i) / r.shares);
    baseFcf = mean(perShare);
    fair = baseFcf / 0.08;
    valuation = { model: "bank-five-year-per-share-perpetuity", perShare };
  } else {
    const cyclic = pol.cycle || requested === "cycle";
    if (cyclic)
      ensure(
        pol.guoTerminalGrowth >= 0 && pol.guoTerminalGrowth <= 0.02,
        "周期终值增长必须0至2%",
      );
    const normal = years.indexOf(pol.normalYear);
    ensure(normal >= 0 && normal < rows.length, "缺冻结正常基期年报");
    if (cyclic && branch === "research") {
      const extra = annual("annualGuo", 6).map((v) => valueGuoSchema.parse(v));
      rows.push(extra[5]!);
    }
    baseFcf = cyclic
      ? mean(rows.slice(0, 5).map(fcfFor))
      : fcfFor(rows[normal]!, normal);
    ensure(baseFcf > 0, "经营资产FCF非正，不支持永续估值");
    ensure(pol.minorityComparable, "少数股东简化比例不适用，缺分部价值证据");
    const r = reconstruction[0]!;
    const investmentValue =
      c.investmentBook === 0 ? 0 : c.investmentIncome / 0.08;
    ensure(investmentValue >= 0, "长期投资收益非正，缺独立价值证据");
    valuation = calculateValuation({
      method: "guo-operating-equity",
      cashFlowBasis: "operating-cash-flow-less-maintenance",
      currency: "CNY",
      amountUnit: "yuan",
      sharesUnit: "shares",
      totalShares: c.shares,
      growthRate: pol.guoGrowth,
      discountRate: 0.08,
      terminalGrowthRate: pol.guoTerminalGrowth,
      assumptionNote: pol.evidence,
      forecastYears: pol.guoYears,
      operatingCashFlow: baseFcf,
      maintenanceCapex: 0,
      financialAssetsValue: r.financial,
      longTermInvestmentsValue: investmentValue,
      interestBearingDebt: c.shortDebt + c.longDebt,
      minorityEquity: c.minorityEquity,
      totalEquity: c.equity,
    });
    fair = (valuation as ReturnType<typeof calculateValuation>).perShareValue;
  }
  ensure(Number.isFinite(fair), "估值非有限数");
  const complete = id === "GY05" || id === "GY06";
  const priorLong = reconstruction[1]?.longAssets;
  const netInvestment = c.capex - c.longAssetDisposalCash;
  const strategy = {
    expansionCapitalRatio:
      priorLong && priorLong > 0
        ? (netInvestment - maintenance(c)) / priorLong
        : null,
    cashSelfSufficiency:
      netInvestment + c.netAcquisitionCash > 0
        ? c.ocf / (netInvestment + c.netAcquisitionCash)
        : null,
    interpretation:
      "固定现金净投资/七项保全近似；无分母不填零，银行/地产不套经营资产解释",
  };
  const classify = (v: number) =>
    m.price <= v * 0.7
      ? "显著低估"
      : m.price >= v * 1.3
        ? "显著高估"
        : "大致合理";
  const sensitivity: { rate: number; terminalGrowth: number; fair: number }[] =
    [];
  if (branch !== "bank" && branch !== "property") {
    const v = valuation as ReturnType<typeof calculateValuation>;
    // Stress the same frozen cash-flow schedule; 7% is only a source sensitivity,
    // never admitted as the base Guo assumption or substituted for WACC.
    for (const rate of [0.07, 0.08, 0.09])
      for (const terminalGrowth of [
        pol.guoTerminalGrowth - 0.01,
        pol.guoTerminalGrowth,
        pol.guoTerminalGrowth + 0.01,
      ]) {
        const operating =
          v.schedule.reduce(
            (n, x) => n + x.cashFlow / (1 + rate) ** x.year,
            0,
          ) +
          (v.schedule.at(-1)!.cashFlow * (1 + terminalGrowth)) /
            (rate - terminalGrowth) /
            (1 + rate) ** pol.guoYears;
        const equity =
          (operating +
            reconstruction[0]!.financial +
            (c.investmentBook === 0 ? 0 : c.investmentIncome / 0.08) -
            c.shortDebt -
            c.longDebt) *
          (1 - c.minorityEquity / c.equity);
        sensitivity.push({
          rate,
          terminalGrowth,
          fair: finite(equity / c.shares),
        });
      }
  }
  const assumptionDependent = sensitivity.some(
    (v) => classify(v.fair) !== classify(fair),
  );
  const quality =
    branch === "bank" || branch === "property"
      ? true
      : reconstruction.every((r) => r.equityAdded > 0) &&
        reconstruction[0]!.longFinancing >= 0 &&
        cashState(c) === 5;
  return result(
    fair > 0 &&
      m.price <= fair * 0.7 &&
      safe &&
      (!complete || (quality && !assumptionDependent)),
    {
      exitEligible: !safe || (complete && !quality) || m.price >= fair,
      strategy,
      sensitivity,
      assumptionDependent,
      conclusion: assumptionDependent ? "区间依赖假设" : classify(fair),
      frozenPolicyVersion: pol.version,
      branch,
      model:
        branch === "bank"
          ? "guo-bank"
          : branch === "property"
            ? "guo-nav"
            : "historical-guo-equity-frozen",
      fair,
      baseFcf,
      valuation,
      safe,
      quality,
      completeSevenStep: complete,
      reconstruction,
      cyclePosition: pol.cyclePosition,
      margin: fair > 0 ? 1 - m.price / fair : null,
    },
    fair,
  );
}

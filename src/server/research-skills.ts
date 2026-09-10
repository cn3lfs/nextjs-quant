import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import ids from "~/lib/trading-skill-ids.json";
import { canslimMethodFiles, canslimMethodVersion } from "./canslim-method";
import { chanMethodFiles, chanMethodVersion } from "./chan-method";
import { wyckoffMethodFiles, wyckoffMethodVersion } from "./wyckoff-method";
import {
  valuationMethodFiles,
  valuationMethodVersions,
} from "./valuation-method";
import type { Snapshot } from "~/lib/domain";
const root = () =>
  process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const volumePriceFiles = [
  "SKILL.md",
  "references/vp-indicators.md",
  "references/vp-patterns.md",
  "references/vp-astock-caveats.md",
];
const sepaFiles = [
  "SKILL.md",
  "references/screening-criteria.md",
  "references/vcp-pattern.md",
  "references/entry-exit-rules.md",
];
const valuationCatalogFiles: Record<string, readonly string[]> = {
  "fundamental-analyst": [
    ...new Set([
      ...valuationMethodFiles.fundamental,
      ...valuationMethodFiles.guo,
    ]),
  ].map((file) => file.slice("fundamental-analyst/".length)),
  "value-investing": valuationMethodFiles.value.map((file) =>
    file.slice("value-investing/".length),
  ),
};
const integrations: Record<
  string,
  { scope: string; requirements: string[]; output: string; budget: string }
> = {
  "swing-trader": {
    scope: "M5本地日线确定性双突破；Phase 3–4，无LLM、无外部行情、无自动交易",
    requirements: [
      "SKILL.md及trading-system/technical-indicators",
      "至少61根已完成不复权日线",
      "M1指标和diagnostic-2已确认极值",
    ],
    output: "dual-breakout-1",
    budget: "仅本地确定性计算；不足结构或指标返回未知",
  },
  "tmt-crowding": {
    scope:
      "只读本地技能CSV并增量归档上交所融资数据；仅关联已核验申万一级TMT的当前A股日线，行业成交/日频尚未自动更新",
    requirements: [
      "SKILL.md与参考计算脚本",
      "同日31行业及四个TMT行业完整序列",
      "原始日期、缓存hash和有效窗口；过期数据不进入当前研究",
    ],
    output: "tmt-crowding-1",
    budget:
      "无模型调用；融资按需请求上交所，10分钟复用查询；三文件各限20MB，同批相关候选共享背景，仅融资有效时不生成TMT总分",
  },
  "gf-windmill": {
    scope:
      "当前指数估值榜单及源关联ETF，跨快评候选共享；不等于全市场情绪或候选指数归属",
    requirements: [
      "本机gf-windmill MCP配置",
      "SKILL.md",
      "完整分页、逐条日期和历史窗口；成分市场与ETF跟踪关系尚未核验",
    ],
    output: "gf-windmill-1",
    budget:
      "最多20页每页10条、45秒总预算；30分钟缓存；每批候选共用一次，不触发模型或交易",
  },
  "fundamental-analyst": {
    scope:
      "基本面五阶段与郭永清七步骤独立资料复核；财务质量、增长、收入口径与人工估值情景，不提供完整评分或自动交易信号",
    requirements: [
      "两条方法路径共五个文件",
      "同一A股已归档连续年度财务与当前不复权日线",
      "财务口径、排雷与重构缺项必须披露；估值参数取显式人工场景",
    ],
    output: "fundamentalReportSchema：基本面五阶段 / 郭永清七步骤",
    budget:
      "背景最多两路并发、30分钟缓存；每报告1次模型请求及最多1次结构修复，同资料/方法/问题/提示版本/模型复用",
  },
  "value-investing": {
    scope:
      "价值投资八步骤资料复核；每股价值命题、反方与核验计划，隐含预期及市场分歧缺证时保留缺失，不产生混合评分",
    requirements: [
      "主方法与philosophy两个完整文件",
      "同一A股年度财务、增长和当前日线",
      "人工估值场景与事实分开，不自行补目标价或交易动作",
    ],
    output: "fundamentalReportSchema：价值投资八步骤",
    budget:
      "与基本面路径共享背景资料缓存；每报告1次模型请求及最多1次结构修复，同证据及方法版本复用",
  },
  "hithink-business-query": {
    scope:
      "明确年度主营构成与前五大客户销售占比；不等于客户/供应商名单或完整业务核验",
    requirements: [
      "IWENCAI_API_KEY",
      "A股身份、年度、源字段定义及单位",
      "主营分类分开，分页覆盖及收入勾稽限制必须披露",
    ],
    output: "business-1 / revenue-reconciliation-1",
    budget: "每类最多20页、单类60秒；同请求并发合并，背景缓存30分钟",
  },
  "hithink-management-query": {
    scope:
      "控股股东/实控人、年度股权集中度及股本；CANSLIM机构与流通盘资料，不代表治理事件全面核验",
    requirements: [
      "IWENCAI_API_KEY",
      "唯一证券身份、源字段定义、股数/比例及各自时点",
      "期末股本不替代当前股本或发行事件",
    ],
    output: "ownership-1 及 CANSLIM 股权证据",
    budget: "控股/年度股本两类请求各30秒，同请求合并；基本面背景缓存30分钟",
  },
  "hithink-insresearch-query": {
    scope:
      "上海当前年起未来三年预测净利润/EPS中值及覆盖家数；不将平均值或单篇研报日期当成中值聚合口径",
    requirements: [
      "IWENCAI_API_KEY",
      "三个目标年度、源端中值定义与单位",
      "聚合更新时间、机构名单、币种及利润归属缺项必须披露",
    ],
    output: "forecast-1",
    budget: "单次30秒，同证券/起始年合并；基本面背景缓存30分钟",
  },
  "hithink-macro-query": {
    scope:
      "全国十年期国债即期收益率、年度GDP、CPI当月同比、PPI累计同比及制造业PMI；不包含完整宏观修订历史",
    requirements: [
      "IWENCAI_API_KEY",
      "系列ID、国家层级、日期/频率及单位",
      "即期利率不替代WACC，累计PPI不替代当月同比",
    ],
    output: "macro-1",
    budget: "五类独立请求，每类30秒；跨证券共享30分钟缓存及并发请求",
  },
  "hithink-event-query": {
    scope:
      "明确年度增发、配股来源事件；监管响应缺字段尚未接入，空事件不证明全年未发行或无监管风险",
    requirements: [
      "IWENCAI_API_KEY",
      "增发与配股各自源定义、日期与股数",
      "上市日期不当发行完成日期；源事件覆盖需披露",
    ],
    output: "capital-events-1",
    budget: "每类最多20页、60秒；同请求合并，基本面背景缓存30分钟",
  },
  "wyckoff-trader": {
    scope:
      "八阶段多周期研究假设；已接入本地沪深300与同日相对强弱，行业及P&F计算证据尚缺，不提供综合评分、目标价或自动信号",
    requirements: [
      "11个方法文件",
      "A股不复权日线、参考交易日历及可选五分钟资料",
      "周线缺口、陈旧小时及不足30根的周期必须披露",
    ],
    output: wyckoffMethodVersion,
    budget:
      "每报告1次模型请求及最多1次结构修复；同证据、问题、方法、提示版本及模型复用报告",
  },
  "chan-theory": {
    scope:
      "五阶段缠论假设标注与课文引用；仅供人工核验，笔、线段及中枢算法未验收，不开放自动扫描或信号",
    requirements: [
      "五个方法文件及可定位课文引文",
      "至少三根已完成的不复权日线或五分钟K线，最多使用末尾300根",
      "图周期不等于走势级别，结构假设及缺口必须披露",
    ],
    output: chanMethodVersion,
    budget:
      "每报告1次模型请求及最多1次结构修复；同窗口、问题、方法及模型复用报告",
  },
  "canslim-analyst": {
    scope: "七因子17分项证据与六阶段研究；未核验项不构成完整评级或交易授权",
    requirements: [
      "五个方法文件",
      "日线、财务、市场及机构等证据",
      "资料覆盖、形态、账户与历史时点缺口必须披露",
    ],
    output: canslimMethodVersion,
    budget: "每报告1次模型请求及最多1次结构修复；同档案、方法及模型复用报告",
  },
  "sepa-strategy-analyst": {
    scope: "六阶段证据研究报告，不等于完整实盘决策",
    requirements: [
      "四个方法文件",
      "市场、财务、趋势、VCP和入场风险证据",
      "缺失RS和账户参数必须披露",
    ],
    output: "sepa-stages-1",
    budget: "每报告1次模型请求，最多1次结构修复；相同证据和方法版本复用报告",
  },
  "volume-price-analysis": {
    scope: "主板日线量价批量快评；其他周期仅指标观察",
    requirements: [
      "至少 60 根已完成 K 线",
      "换手率/除权/停复牌缺口必须披露",
      "市场及行业背景缺失必须披露",
    ],
    output: "quick-review-1",
    budget: "每批最多 5 只，1 次模型请求及最多 1 次结构修复",
  },
  "hithink-finance-query": {
    scope: "当前单股财务证据，不支持历史可用时点",
    requirements: ["IWENCAI_API_KEY", "唯一证券身份、字段单位及报告期核验"],
    output: "evidence-1",
    budget:
      "概览/增长分别缓存 30 分钟；每类空结果最多 2 次改写，每类总超时 30 秒",
  },
  "hithink-basicinfo-query": {
    scope: "当前证券身份、行业归属与上市资料",
    requirements: ["IWENCAI_API_KEY", "精确交易所代码与源分类字段"],
    output: "evidence-1",
    budget: "单次查询 30 秒；与行业指数完整成功后缓存 30 分钟",
  },
  "hithink-industry-query": {
    scope: "当前申万一级行业指数，未覆盖完整行业汇总",
    requirements: [
      "IWENCAI_API_KEY",
      "已核对的行业归属、唯一指数类型/简称/代码",
    ],
    output: "evidence-1",
    budget: "单次查询 30 秒；完整成功缓存 30 分钟",
  },
  "cls-news": {
    scope: "读取本地 CLS 新闻库；分类由独立新闻分类流程提供",
    requirements: ["本地 CLS SQLite 文件", "发布时间和采集时间"],
    output: "本地新闻列表及共享证据",
    budget: "共享新闻缓存 30 秒，最多 12 条",
  },
  "news-industry-classifier": {
    scope:
      "本地新闻单任务最多1000条，固定截止时间按游标继续更早批次，保留部分结果并支持续跑；未覆盖完整主题聚合",
    requirements: [
      "SKILL.md与申万行业分类指南",
      "已选择模型可用",
      "本地新闻原文及来源时点",
    ],
    output: "news-classification-1",
    budget:
      "每批最多25条新新闻，跨范围按原文/规则/模型复用已完成分类；最多40批，每批最多1次修复",
  },
  "westock-data": {
    scope: "证券身份查询及交叉核验",
    requirements: ["本地查询脚本", "证券代码及交易所精确匹配"],
    output: "证券身份核验记录",
    budget: "每请求超时 15 秒",
  },
  "news-sector-analyzer": {
    scope:
      "分类档案内单行业最新50条新闻研究；按已核验申万一级归属为当前候选复用当天背景，不等于个股直接受益；未覆盖价格象限及估值",
    requirements: ["SKILL.md", "已完成分类及冻结原文", "已选择模型可用"],
    output: "news-sector-1",
    budget: "每行业1次请求及最多1次结构修复，相同档案/方法/模型复用",
  },
  "tdx-finance-skill": {
    scope: "8 个只读 MCP 工具；不代表完整技能流程",
    requirements: ["MCP 服务认证", "已授权工具及响应字段核验"],
    output: "行情、在线选股及 evidence-1",
    budget: "单次工具调用超时 25 秒",
  },
};
export type SkillUse = {
  skillId: string;
  ruleVersion: string;
  outputSchema: string;
  files: { file: string; hash: string }[];
  prerequisites: string[];
};
/** P1 reads contracts only; never executes the skill's trading scripts. */
export async function tradingLedgerMethods(): Promise<SkillUse[]> {
  return Promise.all(
    [
      { skillId: "astock-market-rules", names: ["SKILL.md"] },
      {
        skillId: "mock-trading",
        names: ["SKILL.md", "references/api-spec.md"],
      },
    ].map(async ({ skillId, names }) => ({
      skillId,
      ruleVersion: "local-trade-ledger-1",
      outputSchema: "local-trade-ledger-1",
      files: await Promise.all(
        names.map(async (file) => {
          // User-installed method sources are read at runtime outside the bundle.
          // Do not trace the repository as a fallback for this external path.
          const path = join(/* turbopackIgnore: true */ root(), skillId, file);
          const text = await readFile(/* turbopackIgnore: true */ path, "utf8");
          if (!text.trim()) throw new Error(`交易规则文件为空：${file}`);
          return { file, hash: hash(text) };
        }),
      ),
      prerequisites: ["本地人工录入；模拟盘默认关闭；下单需界面确认"],
    })),
  );
}
/** M5: provenance only. Reading a method never executes its tools or prompts. */
export async function breakoutMethod(): Promise<SkillUse> {
  const skillId = "swing-trader";
  const files = await Promise.all(
    [
      "SKILL.md",
      "references/trading-system.md",
      "references/technical-indicators.md",
    ].map(async (file) => {
      const text = await readFile(join(root(), skillId, file), "utf8");
      if (!text.trim()) throw new Error(`双突破方法文件为空：${file}`);
      return { file, hash: hash(text) };
    }),
  );
  return {
    skillId,
    ruleVersion: "dual-breakout-1",
    outputSchema: "dual-breakout-1",
    files,
    prerequisites: [
      "至少61根已完成不复权日线",
      "突破日前60根结构窗口",
      "M1指标沿输入全历史递推",
    ],
  };
}
export async function researchSkillCatalog() {
  return Promise.all(
    ids.map(async (skillId) => {
      const integration = integrations[skillId];
      const files = await Promise.all(
        (
          valuationCatalogFiles[skillId] ??
          (skillId === "swing-trader"
            ? [
                "SKILL.md",
                "references/trading-system.md",
                "references/technical-indicators.md",
              ]
            : skillId === "tmt-crowding"
              ? ["SKILL.md", "scripts/tmt_crowding.py"]
              : skillId === "volume-price-analysis"
                ? volumePriceFiles
                : skillId === "sepa-strategy-analyst"
                  ? sepaFiles
                  : skillId === "canslim-analyst"
                    ? canslimMethodFiles
                    : skillId === "chan-theory"
                      ? chanMethodFiles
                      : skillId === "wyckoff-trader"
                        ? wyckoffMethodFiles
                        : skillId === "news-industry-classifier"
                          ? ["SKILL.md", "references/sw-industries.md"]
                          : ["SKILL.md"])
        ).map(async (file) => {
          try {
            const text = await readFile(join(root(), skillId, file), "utf8");
            if (!text.trim()) throw new Error("方法文件为空");
            return { file, hash: hash(text) };
          } catch {
            return { file, hash: null };
          }
        }),
      );
      const metadata = {
        integrationScope: integration?.scope ?? "尚未实现应用内执行流程",
        prerequisites: integration?.requirements ?? [
          "适用市场、证据和执行流程待核验",
        ],
        outputSchema: integration?.output ?? null,
        budget: integration?.budget ?? "未开放执行，不产生模型调用",
        files,
        missingFiles: files
          .filter((file) => !file.hash)
          .map((file) => file.file),
        implemented: !!integration,
      };
      try {
        const text = await readFile(join(root(), skillId, "SKILL.md"), "utf8");
        return {
          ...metadata,
          skillId,
          installed: true,
          hash: text.trim() ? hash(text) : null,
          status: metadata.missingFiles.length
            ? "incomplete"
            : skillId === "volume-price-analysis"
              ? "quick-review"
              : skillId === "sepa-strategy-analyst" ||
                  skillId === "canslim-analyst" ||
                  skillId === "chan-theory" ||
                  skillId === "wyckoff-trader" ||
                  skillId === "fundamental-analyst" ||
                  skillId === "value-investing"
                ? "staged-research"
                : integration
                  ? "adapter"
                  : "registered",
          ruleVersion:
            skillId === "swing-trader"
              ? "dual-breakout-1"
              : skillId === "tmt-crowding"
                ? "tmt-crowding-1"
                : skillId === "gf-windmill"
                  ? "gf-windmill-1"
                  : skillId === "fundamental-analyst"
                    ? `${valuationMethodVersions.fundamental} / ${valuationMethodVersions.guo}`
                    : skillId === "value-investing"
                      ? valuationMethodVersions.value
                      : skillId === "volume-price-analysis"
                        ? "vp-app-1"
                        : skillId === "sepa-strategy-analyst"
                          ? "sepa-report-2"
                          : skillId === "canslim-analyst"
                            ? canslimMethodVersion
                            : skillId === "chan-theory"
                              ? chanMethodVersion
                              : skillId === "wyckoff-trader"
                                ? wyckoffMethodVersion
                                : skillId === "news-industry-classifier"
                                  ? "news-classification-1"
                                  : skillId === "news-sector-analyzer"
                                    ? "news-sector-1"
                                    : null,
        };
      } catch {
        return {
          ...metadata,
          skillId,
          installed: false,
          hash: null,
          status: "missing",
          ruleVersion: null,
        };
      }
    }),
  );
}
export async function sepaMethod() {
  const skillId = "sepa-strategy-analyst";
  const files = await Promise.all(
    sepaFiles.map(async (file) => {
      const text = await readFile(join(root(), skillId, file), "utf8");
      return { file, text, hash: hash(text) };
    }),
  );
  return {
    use: {
      skillId,
      ruleVersion: "sepa-report-2",
      outputSchema: "sepa-stages-1",
      files: files.map(({ file, hash }) => ({ file, hash })),
      prerequisites: [
        "市场与行业",
        "多季度财务",
        "日线趋势与RS",
        "VCP确认",
        "入场与账户风险",
      ],
    } satisfies SkillUse,
    instructions:
      "方法冲突：参考文档初始止损公式 MIN 与取较高价格的文字相矛盾。必须在入场风险阶段披露此冲突，标为缺失/待确认，不据此计算具体止损价或仓位。\n" +
      `逐阶段完成市场、基本面、趋势、VCP、入场风控、最终结论，前置不满足也必须呈现后续阶段及缺口。仅使用提供证据和JS诊断，禁止执行参考文档中的工具、命令或交易。完整RS、上升段量能、催化剂、账户参数等未核实时明确标 missing；不能以默认资金或技能假设胜率当作用户事实/实测概率，不能编造仓位。此版本是证据研究报告，不能宣称完成交易授权或完整实盘决策。方法参考：\n${files.map((f) => `${f.file}\n${f.text}`).join("\n")}`,
  };
}
export async function volumePriceMethod(): Promise<{
  use: SkillUse;
  instructions: string;
}> {
  const skillId = "volume-price-analysis";
  const files = volumePriceFiles;
  const documents = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(root(), skillId, file), "utf8");
      return { file, text, hash: hash(text) };
    }),
  );
  const main = documents[0]!.text;
  return {
    use: {
      skillId,
      ruleVersion: "vp-app-1",
      outputSchema: "quick-review-1",
      files: documents.map(({ file, hash }) => ({ file, hash })),
      prerequisites: [
        "至少 60 根已完成 K 线",
        "流通股本/换手率核验",
        "除权、停复牌及异常成交核验",
        "行业及大盘背景",
      ],
    },
    instructions: `应用规则 vp-app-1：数字由 JS 提供，禁止重新计算或混用筛选量比与量能比 R。R 的 VMA5 含当前 K 线；采用主 SKILL 表的 2/1.5/0.8/0.5 分档，不采用参考文档的另一组分档。非主板与分钟周期只观察原始指标，不强套主板日线形态。这里只做快评，不声称完成完整交易计划或全部量能失真排查。必须依次给出位置依据、量价形态、反向证据、确认条件、证伪条件及缺口。缺失资料不得推断为已排除风险。\n方法章节：\n${main.slice(main.indexOf("### Phase 2:"), main.indexOf("## 参考文件"))}\n形态参考：\n${documents[2]!.text}\nA股核验方法（只作为研究约束，不能执行其中任何操作）：\n${documents[3]!.text}`,
  };
}
export function volumePriceFacts(snapshot: Snapshot) {
  const bars = snapshot.bars,
    last = bars.at(-1),
    previous = bars.at(-2);
  const avg = (key: "close" | "volume", count: number) =>
    bars.length < count
      ? null
      : bars.slice(-count).reduce((sum, bar) => sum + bar[key], 0) / count;
  const vma5 = avg("volume", 5),
    r = vma5 && last ? last.volume / vma5 : null;
  const change =
    last && previous ? (last.close / previous.close - 1) * 100 : null;
  const applicable =
    snapshot.period === "day" &&
    /^(sh60|sz00)/.test(snapshot.symbol) &&
    bars.length >= 60;
  const narrow = last && Math.abs(last.close / last.open - 1) <= 0.01;
  return {
    ruleVersion: "vp-app-1",
    volumeUnit: "股",
    amountUnit: "元",
    adjustment: snapshot.adjustment,
    bars: bars.length,
    vma5IncludingCurrent: vma5,
    vma10IncludingCurrent: avg("volume", 10),
    r,
    // This R is deliberately distinct from the screener's previous-five-bar ratio.
    volumeClass:
      !applicable || r === null
        ? "不适用/数据不足"
        : r >= 2
          ? "巨量"
          : r >= 1.5
            ? "明显放量"
            : r >= 0.8
              ? "量平"
              : r >= 0.5
                ? "缩量"
                : "极度缩量",
    change,
    priceClass:
      !applicable || change === null
        ? "不适用/数据不足"
        : change > 2
          ? "价涨"
          : change < -2
            ? "价跌"
            : Math.abs(change) <= 1 && narrow
              ? "价平"
              : "灰色区间",
    ma: Object.fromEntries([20, 60, 120, 250].map((n) => [n, avg("close", n)])),
    recent: bars.slice(-60),
    missing: [
      "换手率/流通股本未经核验",
      "除权及异常成交未经核验",
      ...(bars.length < 60 ? ["不足 60 根 K 线"] : []),
      ...(!applicable ? ["不套用主板日线默认阈值"] : []),
    ],
  };
}

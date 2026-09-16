import { growthIntradayDescription } from "~/lib/research-growth-intraday";
import { growthDailyDescription } from "~/lib/research-growth-daily";
import { researchKellySwitchVersion } from "~/lib/research-kelly-switch";
import {
  isGrowthPivotStop,
  growthPivotStopDescription,
} from "~/lib/research-growth-stops";
import { sepaEliteDescription } from "~/lib/research-sepa-elite";
import {
  isGrowthDailyExit,
  growthDailyExitDescription,
} from "~/lib/research-growth-exits";
import { researchKellyQualityVersion } from "~/lib/research-kelly-quality";
import { researchKellyPayoffVersion } from "~/lib/research-kelly-payoff";
import { researchKellyTrainingVersion } from "~/lib/research-kelly-training";
import { researchKellyVersion } from "~/lib/research-kelly";
import { researchBreakoutStopVersion } from "~/lib/research-breakout-stops";
import { createHash } from "node:crypto";
import {
  researchExitPresetVersion,
  researchExitPresetLabels,
  canslimExitDescription,
  isSepaExitPreset,
  sepaExitDescription,
  isCanslimProgressPreset,
} from "~/lib/research-exit-presets";
import {
  researchProgressExitDescription,
  researchProgressExitVersion,
} from "~/lib/research-progress-exit";
import {
  isResearchRManagementTemplate,
  researchRManagementVersion,
} from "~/lib/research-r-management";
import { researchLiquidityVersion } from "~/lib/research-liquidity";
import sourceLock from "../../docs/trading-skills-source-lock.json";
import { researchLossPauseVersion } from "~/lib/research-loss-pause";
import { researchRetracementVersion } from "~/lib/research-retracement";
import { researchMarketChopVersion } from "~/lib/research-market-chop";
import { researchMarketRegimeVersion } from "~/lib/research-market-regime";
import { swingExitKind, swingExitVersion } from "~/lib/research-swing-exits";
import {
  researchManagementSources,
  researchManagementVersion,
  researchScaleOutVersion,
  researchProtectionVersion,
  researchPyramidVersion,
  researchPullbackVersion,
} from "~/lib/research-management";
import type { ResearchSpec } from "~/lib/strategy-research";
import {
  researchStrategies,
  type ResearchStrategyId,
} from "~/lib/research-strategies";

// This is the revision interpreted by this implementation, not whichever
// skill happens to be installed when an old experiment is opened or retried.
export function researchMethodSnapshot(
  input: ResearchStrategyId | Pick<ResearchSpec, "strategy" | "management">,
  management = false,
  scaleOut = false,
) {
  const strategy = typeof input === "string" ? input : input.strategy;
  if (typeof input !== "string") {
    management = !!input.management;
    scaleOut = !!input.management?.scaleOut;
  }
  const protection =
    typeof input !== "string" &&
    !!(
      input.management?.breakeven ||
      input.management?.trailAfterScaleOut ||
      input.management?.trail.kind === "close-atr"
    );
  const definition = researchStrategies[strategy];
  const netPayoffKelly =
    typeof input !== "string" &&
    input.management?.kelly?.provenance === "development-net-payoff";
  const trainedKelly =
    typeof input !== "string" &&
    (input.management?.kelly?.provenance === "development-closed" ||
      netPayoffKelly);
  const kelly = typeof input !== "string" && !!input.management?.kelly;
  const exitPreset =
    typeof input !== "string" ? input.management?.exitPreset : undefined;
  const progressExit =
    typeof input !== "string" && input.management?.progressExit;
  const stopOverride =
    typeof input !== "string" && !!input.management?.stopOverride;
  const structureAuto =
    typeof input !== "string" &&
    input.management?.stop.kind === "structure-auto";
  const rBreakeven =
    typeof input !== "string" && input.management?.breakeven?.mode === "r-only";
  const rManagement =
    typeof input !== "string" &&
    isResearchRManagementTemplate(input.management);
  const breakoutStop =
    typeof input !== "string" &&
    (input.management?.stop.kind === "breakout-candle" ||
      input.management?.stop.kind === "platform-upper")
      ? input.management.stop.kind
      : undefined;
  const nearestStop =
    typeof input !== "string" && input.management?.stop.kind === "nearest-stop";
  const maxDistance =
    typeof input !== "string" && input.management?.stop.kind === "max-distance";
  const liquidityCap =
    typeof input !== "string" && !!input.management?.liquidityCap;
  const structureDistance =
    typeof input !== "string" &&
    input.management?.stop.kind === "structure-atr" &&
    input.management.stop.maxDistanceAtr != null;
  const structureAtr =
    typeof input !== "string" &&
    input.management?.stop.kind === "structure-atr";
  const distanceTrail =
    typeof input !== "string" && input.management?.trail.kind === "distance";
  const rollingChandelier =
    typeof input !== "string" &&
    input.management?.trail.kind === "rolling-chandelier";
  const retracement =
    typeof input !== "string" && input.management?.trail.kind === "retracement";
  const lossPause =
    typeof input !== "string" && !!input.management?.lossPauseDays;
  const marketRegime =
    typeof input !== "string" && !!input.management?.marketRegime;
  const marketChop =
    typeof input !== "string" && !!input.management?.marketChop;
  const entryLimits =
    typeof input !== "string" &&
    (input.management?.maxInitialStopDistance != null ||
      input.management?.maxTotalWeight != null);
  const swingExit =
    typeof input === "string" ? null : swingExitKind(input.management);
  const pyramid =
    typeof input !== "string" &&
    input.management?.pyramid?.kind === "r-50-30-20";
  const pullback =
    typeof input !== "string" &&
    input.management?.pyramid?.kind === "pullback-50-50";
  const sources = [
    ...new Set([
      ...definition.sources,
      ...(typeof input !== "string" &&
      input.management &&
      isGrowthPivotStop(input.management.stop.kind)
        ? [
            input.management.stop.kind.startsWith("sepa")
              ? "sepa-strategy-analyst/references/entry-exit-rules.md"
              : "canslim-analyst/references/entry-exit-rules.md",
          ]
        : []),
      ...(kelly
        ? ["stop-loss/references/kelly-sizing.md", "stop-loss/scripts/kelly.py"]
        : []),
      ...(breakoutStop ? ["stop-loss/SKILL.md"] : []),
      ...(progressExit
        ? [
            exitPreset?.startsWith("sepa-")
              ? "sepa-strategy-analyst/references/entry-exit-rules.md"
              : "canslim-analyst/references/entry-exit-rules.md",
          ]
        : []),
      ...(exitPreset
        ? [
            exitPreset.startsWith("sepa-")
              ? "sepa-strategy-analyst/references/entry-exit-rules.md"
              : exitPreset.startsWith("canslim-")
                ? "canslim-analyst/references/entry-exit-rules.md"
                : "stop-loss/references/management.md",
          ]
        : []),
      ...(stopOverride || structureAuto
        ? ["stop-loss/scripts/stop_loss_calc.py"]
        : []),
      ...(rBreakeven || rManagement
        ? ["stop-loss/scripts/stop_loss_calc.py"]
        : []),
      ...(nearestStop
        ? ["stop-loss/SKILL.md", "stop-loss/scripts/stop_loss_calc.py"]
        : []),
      ...(maxDistance ? ["stop-loss/scripts/stop_loss_calc.py"] : []),
      ...(liquidityCap ? ["stop-loss/references/position-sizing.md"] : []),
      ...(management ? researchManagementSources : []),
      ...(scaleOut || protection || pyramid || pullback
        ? ["stop-loss/references/management.md"]
        : []),
      ...(pyramid || pullback
        ? ["swing-trader/references/position-management.md"]
        : []),
      ...(pullback ? ["swing-trader/references/trading-system.md"] : []),
      ...(marketChop ? ["swing-trader/references/trading-system.md"] : []),
      ...(lossPause
        ? [
            "swing-trader/references/trading-system.md",
            "swing-trader/references/position-management.md",
          ]
        : []),
      ...(marketRegime
        ? [
            "swing-trader/references/trading-system.md",
            "swing-trader/references/position-management.md",
          ]
        : []),
      ...(entryLimits
        ? ["swing-trader/references/position-management.md"]
        : []),
      ...(swingExit
        ? [
            "swing-trader/references/trading-system.md",
            "swing-trader/references/position-management.md",
          ]
        : []),
    ]),
  ]
    .sort()
    .map((path) => {
      const slash = path.indexOf("/");
      const skill = sourceLock.skills.find(
        (row) => row.id === path.slice(0, slash),
      );
      const source = skill?.sources.find(
        (row) => row.path === path.slice(slash + 1),
      );
      if (!source) throw new Error(`策略来源未冻结：${path}`);
      return {
        path,
        sha256: source.hash,
      };
    });
  const content = {
    ...(typeof input !== "string" && input.management?.growthDaily
      ? {
          growthDaily: {
            version: "growth-daily-methods-1",
            id: input.management.growthDaily,
            interpretation: growthDailyDescription,
          },
        }
      : {}),
    ...(typeof input !== "string" && input.management?.growthIntraday
      ? {
          growthIntraday: {
            version: "growth-intraday-1",
            id: input.management.growthIntraday,
            interpretation: growthIntradayDescription,
          },
        }
      : {}),
    ...(typeof input !== "string" &&
    input.management &&
    isGrowthPivotStop(input.management.stop.kind)
      ? {
          growthPivotStop: {
            version: "growth-pivot-stop-1",
            kind: input.management.stop.kind,
            interpretation: growthPivotStopDescription,
          },
        }
      : {}),
    ...(typeof input !== "string" && input.management?.sepaElite
      ? {
          sepaElite: {
            version: "sepa-elite-entry56-1",
            interpretation: sepaEliteDescription,
          },
        }
      : {}),
    ...(isGrowthDailyExit(strategy)
      ? {
          growthDailyExit: {
            version: "growth-daily-exit-1",
            interpretation: growthDailyExitDescription,
            configuration:
              typeof input === "string" ? null : (input.management ?? null),
          },
        }
      : {}),
    ...(typeof input !== "string" &&
    input.management?.kelly?.provenance === "rolling-switch30"
      ? {
          kellySwitch: {
            version: researchKellySwitchVersion,
            interpretation:
              "每个分区独立累计本组合截至买入日前完整闭合净交易，零收益计非胜；不足30笔按原信号五项质量代理及四分之一，达到30笔实测p及半凯利。b人工固定，未知质量/重复交易禁买。首仓及加仓当日重算参数源，同日退出不计入；不借用开发期交易到验证期，不使用未来交易，非开发期参考组合固定参数版本。",
          },
        }
      : {}),
    ...(typeof input !== "string" &&
    input.management?.kelly?.provenance === "breakout-quality"
      ? {
          kellyQuality: {
            version: researchKellyQualityVersion,
            interpretation:
              "基础双突破信号冻结的趋势/压力/量能/指标/形态五项检查，3/4/5映射假设p0.45/0.50/0.55；未知或不足3项禁买。首仓及加仓均使用原信号档位，b和分数为人工参数；不代表实测胜率，不自动切换30笔统计。",
          },
        }
      : {}),
    ...(netPayoffKelly
      ? {
          kellyNetPayoff: {
            version: researchKellyPayoffVersion,
            interpretation:
              "同开发期参考样本的严格盈利净损益金额均值/严格亏损净损益金额绝对值均值；零收益不参与两边均值，胜率仍以全部闭合样本为分母。至少30笔且两侧均有样本，缺失或非有限比值不回退。不是目标空间b或收益率均值比；参考仓位大小影响金额口径，验证期固定使用。",
          },
        }
      : {}),
    ...(trainedKelly
      ? {
          kellyTraining: {
            version: researchKellyTrainingVersion,
            interpretation: netPayoffKelly
              ? "开发期参考组合关闭凯利；至少30笔验证前完整闭合记录形成固定胜率及净损益金额均值比，缺少盈亏任一侧不可用。样本/截止/参考规格来源保存，验证期独立资金，分数仍为人工假设。"
              : "开发期参考组合关闭凯利，其他入场/退出/风险参数保持；仅验证开始前完整闭合的净收益记录，至少30笔后固定胜率用于独立资金验证期。零收益为非胜，重复身份拒绝，未平仓和验证期数据不计入；保存样本、截止日、参考来源与hash。b与分数仍为人工假设，不足样本不回退人工p。",
          },
        }
      : {}),
    ...(kelly
      ? {
          kelly: {
            version: researchKellyVersion,
            interpretation: trainedKelly
              ? "胜率来自开发期参考组合的已闭合净收益，截止验证开始前；验证期固定应用分数凯利，风险/市值/容量和原交易规则仍生效。"
              : "人工参数在整个区间固定，标记manual-scenario；p为假设胜率、b为显式假设回报倍数，不冒充历史实测或质量评分。f*=p-(1-p)/b，非正或无效停止买入；正值乘分数作为单股总市值上限，首仓/加仓均与风险、市值、容量取严格约束。资金费用、数量取整及可成交条件仍由原引擎执行；逐次检查记录权益、风险预算、凯利/单股上限、原持仓及实际买入数量，卖出不受阻。",
          },
        }
      : {}),

    version: "research-method-1" as const,
    strategy,
    ruleVersion: definition.version,
    label: definition.label,
    interpretation: definition.description,
    ...(management
      ? {
          management: {
            version: researchManagementVersion,
            interpretation:
              "组合风控替代基础策略的资金均分和仅固定持有退出。信号日算术均值ATR；收盘确认、次日开盘退出；移动线只升不降，更新后下一交易日生效。吊灯锚点取持仓以来最高价。时间退出从入场日收盘计数。压力缓冲为显式实验假设，非未来最坏价或亏损保证。固定事件观察仍用holdingDays。",
          },
        }
      : {}),
    sourceVersion: sourceLock.version,
    ...(progressExit
      ? {
          progressExit: {
            version: researchProgressExitVersion,
            configuration: progressExit,
            interpretation: exitPreset?.startsWith("sepa-")
              ? sepaExitDescription
              : researchProgressExitDescription,
          },
        }
      : {}),
    ...(exitPreset
      ? {
          exitPreset: {
            version: researchExitPresetVersion,
            kind: exitPreset,
            label: researchExitPresetLabels[exitPreset],
            interpretation: isSepaExitPreset(exitPreset)
              ? sepaExitDescription
              : isCanslimProgressPreset(exitPreset)
                ? researchProgressExitDescription
                : exitPreset.startsWith("canslim-")
                  ? canslimExitDescription
                  : "固定2R/3R按首仓初始R设置整仓目标，收盘确认后下一可成交开盘退出；仅跟随不设固定目标；混合版本半仓2R实际成交后启用尾仓，均无额外保本或减半后抬1R。尾仓/仅跟随明确采用22周期窗口最高价减3ATR，是对原文未指定跟随算法的工程选择。只上移，收盘更新次日起生效；数量取整、T+1、跳空、费用及无法成交按既有执行处理。保留初始定位、信号/时间退出和最长持有，不用事后市场状态过滤。",
          },
        }
      : {}),
    ...(stopOverride
      ? {
          stopOverride: {
            version: "research-stop-override-1",
            interpretation:
              "显式绝对止损绑定证券和信号观察日，精确匹配才覆盖初始候选，未匹配事件保持原定位。人工实验输入单独标记，不证明该价位在历史当时已被登记；不得据此宣称无前视历史建议。非正、非有限或不低于实际入场价拒绝，独立距离/容量/风险门槛仍生效；2ATR门槛仍要求有效ATR。实际采用的覆盖记录随成交保存，不伪造候选证据。",
          },
        }
      : {}),
    ...(structureAuto
      ? {
          structureAuto: {
            version: "research-structure-auto-1",
            interpretation:
              "脚本结构缓冲提供ATR时取结构价减0.3ATR，未提供时取结构价下方0.5%。本版本以是否配置ATR周期代表是否提供ATR；已配置但信号窗口缺失/无效时不入场，不静默回退。默认14周期为工程起点，倍数与百分比可调；结构沿用双突破摆动低点或平台下沿，信号证据冻结，非正或不低于实际入场价拒绝。",
          },
        }
      : {}),
    ...(rBreakeven
      ? {
          rBreakeven: {
            version: "research-r-breakeven-1",
            interpretation:
              "仅以收盘达到首仓价加指定初始R确认，下一交易日起保本线至少首仓成交价，不需要后续更高低点。既有退出意图不撤销，不按当日最高价回溯触发，不保证覆盖费用或跳空；加仓不重置首价和初始R。",
          },
        }
      : {}),
    ...(rManagement
      ? {
          rManagement: {
            version: researchRManagementVersion,
            interpretation:
              "具名组合：1R收盘确认后保本；2R确认后下一可成交开盘减半，完成按规则取整的减仓目标后抬至1R，再激活22周期窗口最高价减3ATR的尾仓线。脚本未指定跟随方法，本组合采用methods.md的22/3吊灯定义；仅上移，收盘更新次日起生效，分批受阻继续且全退出优先。初始定位和独立时间退出保留，首仓R不随加仓改变，半仓按实际累计买入股数及数量规则处理。",
          },
        }
      : {}),
    ...(breakoutStop
      ? {
          breakoutStop: {
            version: researchBreakoutStopVersion,
            kind: breakoutStop,
            interpretation:
              "突破K线低点取信号日最低价，收盘后可知；平台上沿复用已有双突破平台定义，仅取信号从下方突破且此前已确认的平台，最近确认优先、同日取较高价。默认低点缓冲0，平台下方0.5%为工程选择；不以平台下沿/摆动低点替代缺失证据。原价与确认日写入信号证据，实际成交后的距离参与风险仓位，显式覆盖优先。",
          },
        }
      : {}),
    ...(nearestStop
      ? {
          nearestStop: {
            version: "research-nearest-stop-1",
            interpretation:
              "最早离场的同一收盘确认三方案做多版本：百分比、实际入场价减信号ATR倍数、冻结结构减ATR缓冲，三项合法下方候选取最高价。默认5%、14周期1.5ATR与0.3ATR结构缓冲采用脚本候选参数，近端选择来自技能入口；14周期为工程定义。结构沿用双突破摆动低点或平台下沿，缺任一候选拒绝入场。选中距离用于含费风险股数并保留候选，不表示所有盘中与异步触发规则已实现。显式人工覆盖优先且单独记录；旧最大距离版本不变。",
          },
        }
      : {}),
    ...(maxDistance
      ? {
          maxDistance: {
            version: "research-max-distance-1",
            interpretation:
              "脚本最大距离的三方案做多工程版本：实际入场价的百分比、入场价减信号日ATR倍数、信号结构位减ATR缓冲，三项合法下方止损取最低价。默认5%、14周期1.5ATR、结构0.3ATR缓冲；结构沿用双突破摆动低点或平台下沿。缺任一输入或任一候选非法则不入场，不静默丢弃候选。成交记录保留全部候选，选中距离用于含费风险仓位；最大距离不等于最早离场或风险更小。显式覆盖、缺ATR回退和做空另列，14周期是工程定义。",
          },
        }
      : {}),
    ...(liquidityCap
      ? {
          liquidityCap: {
            version: researchLiquidityVersion,
            interpretation:
              "买入前20个连续快照交易日平均成交额的1%作为单股总持仓市值上限，成交额按本地日线契约使用元。首仓与加仓共同受限，并与风险及仓位上限取更严格值；费用处理沿用现有保守仓位算法。窗口缺失或无有效成交则暂停买入，原等待期限不延长，卖出照常。容量下降不会主动卖出；该容量代理不等于实际滑点或可成交保证。",
          },
        }
      : {}),
    ...(structureDistance
      ? {
          structureDistance: {
            version: "research-structure-distance-1",
            interpretation:
              "methods.md波段组合：实际入场成交价至缓冲后结构止损距离超过2倍信号日ATR则取消该事件，等于2倍允许。共享structure-atr信号ATR周期，入场后数据不回填；不夹紧或重算止损凑准入，不等待未来价格下降重新激活同一事件。后续独立信号可以重新评估。百分比距离及资金风险门槛仍独立生效，本项只约束首仓；严格摆动低点与回踩再入场组合另列。",
          },
        }
      : {}),
    ...(structureAtr
      ? {
          structureAtr: {
            version: "research-structure-atr-1",
            interpretation:
              "methods.md A3的ATR缓冲工程版本：复用双突破信号已有结构支撑（摆动低点或平台下沿），减信号日算术ATR乘缓冲倍数，默认14周期0.3倍。结构和ATR冻结于信号日，不使用入场后行情；缺输入、非正或不低于实际入场价则拒绝，不退回百分比止损。真实缓冲距离参与风险仓位，既有百分比最大距离门槛仍独立生效。严格仅摆动低点与2ATR距离禁入组合另列，平台下沿来源不冒充纯摆动低点。",
          },
        }
      : {}),
    ...(distanceTrail
      ? {
          distanceTrail: {
            version: "research-distance-trail-1",
            interpretation:
              "methods.md D3固定距离跟随：持仓以来已完成日线最高价减固定价格差，默认1个价格单位是工程起点，参数与行情价格同单位，不是百分比或ATR。收盘更新后下一交易日起生效，仅上移，沿用所选收盘确认；新线不能回看当日触发，已有退出意图优先。分批和加仓不重置最高锚点；可配置全部减仓档实际成交后启用。不同价格水平应分别登记参数，不能把相同绝对距离视为相同风险。",
          },
        }
      : {}),
    ...(rollingChandelier
      ? {
          rollingChandelier: {
            version: "research-rolling-chandelier-1",
            interpretation:
              "volatility-family.md明确最近22根最高价减3ATR22，与同段持仓最高锚点分开。使用完整历史尾窗（包括入场前有效记录），窗口与ATR共用可调周期，默认22/3；共享算术ATR。收盘计算，下一交易日起生效，仅向上收紧，旧高点移出或ATR扩大均不放宽已有线。无效/停牌记录使窗口不可用，保留旧线并记录原因。源数据缺失日期不是自动补齐的交易日，实际基准日历连续性另行核验。可配末档实际完成后激活，原止损及待卖意图仍有效。",
          },
        }
      : {}),
    ...(retracement
      ? {
          retracement: {
            version: researchRetracementVersion,
            interpretation:
              "methods.md D4：首仓成交价减首仓初始止损冻结1R，最高价格浮盈达到2/3/4/7R时分别允许回吐30/25/20/5%，取已达到最高档。止损=首仓价+最高价格浮盈乘保留比例；收盘使用当日已完成高点更新，下一交易日起生效，仅上移。原文未规定盘中或收盘，本版本沿用已选择收盘确认，不能用新线回看当日退出。分批和加仓不重置首仓R，已实现利润及费用不纳入此价格浮盈，最终含费利润独立核算。可与末档实际成交后激活组合。",
          },
        }
      : {}),
    ...(marketChop
      ? {
          marketChop: {
            version: researchMarketChopVersion,
            interpretation:
              "原文MA20附近反复穿越采用显式工程参数：最近N个已完成快照交易日均在指定距离带内，相邻收盘对各自MA20的偏离符号反转达到次数门槛；恰好触线不计穿越并打断相邻对。默认10日、3次、上下3%。仅使用前日及以前数据，缺完整连续有效窗口暂停首仓/加仓但不触发清仓。确认震荡后下一开盘退出已有持仓，受阻的退出意图保留；买入暂停，等待期限不延长。后续窗口不再满足时解除环境禁入，其他门槛仍独立生效。MA20复用共享指标，结果保存每日时点、穿越次数及状态；不代表完整市场环境系统。",
          },
        }
      : {}),
    ...(lossPause
      ? {
          lossPause: {
            version: researchLossPauseVersion,
            interpretation:
              "每个独立资金分区按完整头寸最终含费盈亏计连续亏损，负数计亏，零或盈利打断；分批尚未全平不计。第三笔结算当日阻止后续首仓/加仓，再休息接下来1或2个快照交易日，冷静期结束后的下一交易日恢复。触发后连亏从0重计，冷静期内继续结算，新三笔可延长；盈利不提前解除既有冷静期。同日交易按现有确定性开盘卖出顺序处理（建仓插入顺序），不根据收益排序。卖出继续、待买等待期不延长；记录每笔结算与暂停状态，区间末尾未知恢复日期留空。",
          },
        }
      : {}),
    ...(marketRegime
      ? {
          marketRegime: {
            version: researchMarketRegimeVersion,
            interpretation:
              "使用快照基准和交易日历，开盘买入仅参考前一日完成值；21根连续有效OHLC/正量计算相邻MA20。价格高于中性带且MA20上升为强60%，低于中性带且下降为弱0或30%，其余中性30%；中性带为公开工程参数。缺失暂停首仓及加仓，等待期限不重置；卖出不受阻，存量不强制平仓。总仓与固定/加仓限额取小，每日类别、参考日期、均线和缺失原因留证。快照日历本身不代表已核验完整交易所日历。",
          },
        }
      : {}),
    ...(entryLimits
      ? {
          entryLimits: {
            version: "research-entry-limits-1",
            interpretation:
              "实际拟成交价至初始止损距离超过上限则取消首仓，不缩窄止损。总仓上限约束所有首仓及加仓；首仓按持仓前收和已知交易估值，预算保守包含买入费用，加仓按既有持仓执行估值。与加仓模式上限取更小者，存量涨价超限只阻止新买入，不自动减仓。参数、时点与缺估值拒入均保留。",
          },
        }
      : {}),
    ...(swingExit
      ? {
          swingExit: {
            version: swingExitVersion,
            kind: swingExit,
            interpretation: `首价和初始止损冻结R，1R/2R各减累计实际买入股数三分之一，第一档不抬线。${swingExit === "prior-target" ? "第二档实际完成后剩余止损至少第一目标1R，已有更高线不降低。" : "第二档不抬线，保留初始止损。"}一根有效收盘触及或跌破止损后下一可成交开盘退出；分单、费用、T+1及受阻保留意图继续。模板不覆盖信号退出或最长持有，可叠加时间退出，不保证目标价成交。`,
          },
        }
      : {}),
    ...(scaleOut
      ? {
          scaleOut: {
            version: researchScaleOutVersion,
            interpretation:
              "初始数量分档，收盘确认后下一可成交开盘卖出。每档向下取有效数量；实际完成减仓后才抬升剩余止损。每根收盘最多新触发一档，全退出优先；费用逐笔计，整笔清仓后才进入闭合收益统计。原文最低锁定收益不覆盖跳空与无法成交。",
          },
        }
      : {}),
    sources,
    ...(pullback
      ? {
          pullback: {
            version: researchPullbackVersion,
            interpretation:
              "双突破首仓冻结计划量并买入50%，第二笔目标为首仓实际股数，受资金和申报约束可不足。突破位取信号时趋势线与关键压力位较高者；信号后指定根数内最低价进入冻结位至容差上沿、未破位才确认，收盘确认后下一开盘补入。默认仅等次根，等待成交不重启确认期。计划分批允许第二笔低于首价，与仅盈利对照分别配置，不套用递减金字塔；实际补入仍须守位、原风险预算与总仓位上限。第二笔统一止损至少冻结突破位且不降低原线，不保证保本。FIFO逐批成本/T+1、减仓或全退出优先且永久停止补入。原文盘中入场未由本日线收盘版本覆盖。",
          },
        }
      : {}),
    ...(pyramid
      ? {
          pyramid: {
            version: researchPyramidVersion,
            interpretation:
              "首仓冻结计划总量，按50/30/20递减买入；首价初始R的1R/2R收盘触发，下一可成交开盘仍须盈利。第二笔统一止损重算含费及压力保本，第三笔首仓成本且不降低已有线。每档最多一笔，数量向下取整，预算不足等待后到期停止。总风险不超过首仓账户风险预算，单股及总仓位约束每次重算。FIFO逐批成本与T+1；分批卖出按实际累计买入量，全退出/减仓优先且永久停止加仓；收益以全部买入成本为分母。当前卖出规则估算未来分单费用，不保证未来成交或最大亏损。50/50回踩版未由本版本替代。",
          },
        }
      : {}),
    ...(protection
      ? {
          protection: {
            version: researchProtectionVersion,
            interpretation: rBreakeven
              ? "本配置使用仅R确认保本，规则见rBreakeven；未启用结构确认。尾仓跟随可要求所有减仓档实际完成后激活，新线只升不降，收盘更新次日起生效；不保证含费保本。"
              : "结构保本需收盘达到指定R，且复用VCP近60根左右各3根确认的最近两个低点；后低点高于前低点和入场价，发生在入场后，不跨歧义或停牌线。移至成交价，不保证含费保本。收盘ATR线为当日收盘减算术ATR倍数；可要求所有减仓档实际完成后激活。新止损仅从下一交易日起生效、只升不降。",
          },
        }
      : {}),
  };
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}

export type ResearchMethodSnapshot = ReturnType<typeof researchMethodSnapshot>;

export function validateResearchMethod(
  strategy: ResearchStrategyId | Pick<ResearchSpec, "strategy" | "management">,
  saved: ResearchMethodSnapshot | undefined,
  management = false,
  scaleOut = false,
) {
  // Absence remains visible in legacy results. Never invent their provenance.
  if (!saved) return;
  if (
    JSON.stringify(saved) !==
    JSON.stringify(researchMethodSnapshot(strategy, management, scaleOut))
  )
    throw new Error(
      "保存的方法版本与当前实现不一致，请新建研究任务；原快照保持不变",
    );
}

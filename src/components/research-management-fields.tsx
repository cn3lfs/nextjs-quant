import type { ResearchManagement } from "~/lib/research-management";
import { researchScaleOutPreset } from "~/lib/research-management";
import { swingExitTemplate, swingExitKind } from "~/lib/research-swing-exits";
import {
  clearStaleExitPreset,
  researchExitPresetIds,
  researchExitPresetLabels,
  researchExitPresetTemplate,
  isCanslimExitPreset,
  isCanslimProgressPreset,
  canslimExitDescription,
} from "~/lib/research-exit-presets";
import { researchProgressExitDescription } from "~/lib/research-progress-exit";
import {
  researchRManagementTemplate,
  isResearchRManagementTemplate,
} from "~/lib/research-r-management";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export function ResearchManagementFields({
  value,
  onChange: emitChange,
  allowStructure,
}: {
  value: ResearchManagement;
  onChange: (value: ResearchManagement) => void;
  allowStructure: boolean;
}) {
  const onChange = (next: ResearchManagement) =>
    emitChange(clearStaleExitPreset(next));
  const pullback =
    value.pyramid?.kind === "pullback-50-50" ? value.pyramid : null;
  const number = (
    label: string,
    current: number,
    change: (value: number) => void,
    scale = 1,
  ) => (
    <label>
      {label}
      <Input
        aria-label={label}
        type="number"
        step="any"
        value={
          scale === 1 || !Number.isFinite(current)
            ? current
            : Number((current * scale).toPrecision(15))
        }
        onChange={(event) => change(event.target.valueAsNumber / scale)}
      />
    </label>
  );
  return (
    <>
      <label>
        凯利仓位上限
        <Select
          value={
            value.kelly?.provenance === "rolling-switch30"
              ? "switch30"
              : value.kelly?.provenance === "breakout-quality"
                ? "quality"
                : value.kelly?.provenance === "development-net-payoff"
                  ? "net-payoff"
                  : value.kelly?.provenance === "development-closed"
                    ? "trained"
                    : value.kelly
                      ? "on"
                      : "off"
          }
          onValueChange={(raw) => {
            const { kelly: _old, ...rest } = value;
            onChange(
              raw === "switch30"
                ? {
                    ...rest,
                    kelly: {
                      provenance: "rolling-switch30",
                      payoff:
                        value.kelly && "payoff" in value.kelly
                          ? value.kelly.payoff
                          : 2,
                      fraction: 0.5,
                    },
                  }
                : raw === "quality"
                  ? {
                      ...rest,
                      kelly: {
                        provenance: "breakout-quality",
                        payoff:
                          value.kelly && "payoff" in value.kelly
                            ? value.kelly.payoff
                            : 2,
                        fraction: value.kelly?.fraction ?? 0.5,
                      },
                    }
                  : raw === "net-payoff"
                    ? {
                        ...rest,
                        kelly: {
                          provenance: "development-net-payoff",
                          fraction: value.kelly?.fraction ?? 0.5,
                        },
                      }
                    : raw === "trained"
                      ? {
                          ...rest,
                          kelly: {
                            provenance: "development-closed",
                            payoff:
                              value.kelly && "payoff" in value.kelly
                                ? value.kelly.payoff
                                : 2,
                            fraction: value.kelly?.fraction ?? 0.5,
                          },
                        }
                      : raw === "on"
                        ? {
                            ...rest,
                            kelly: {
                              winRate: 0.5,
                              payoff: 2,
                              fraction: 0.5,
                              provenance: "manual-scenario",
                            },
                          }
                        : rest,
            );
          }}
        >
          <SelectTrigger aria-label="凯利仓位上限">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">关闭</SelectItem>
            <SelectItem value="on">人工参数实验</SelectItem>
            {allowStructure && (
              <SelectItem value="switch30">30笔滚动切换参数</SelectItem>
            )}
            {allowStructure && (
              <SelectItem value="quality">双突破五项质量代理</SelectItem>
            )}
            <SelectItem value="trained">开发期30笔实测胜率</SelectItem>
            <SelectItem value="net-payoff">开发期胜率与净损益比</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.kelly && (
        <>
          {value.kelly.provenance === "manual-scenario" &&
            number(
              "假设胜率（%）",
              value.kelly.winRate,
              (winRate) => {
                if (value.kelly?.provenance === "manual-scenario")
                  onChange({ ...value, kelly: { ...value.kelly, winRate } });
              },
              100,
            )}
          {value.kelly.provenance !== "development-net-payoff" &&
            number("假设回报倍数b", value.kelly.payoff, (payoff) => {
              if (
                value.kelly &&
                value.kelly.provenance !== "development-net-payoff"
              )
                onChange({ ...value, kelly: { ...value.kelly, payoff } });
            })}
          {value.kelly.provenance !== "rolling-switch30" &&
            number("凯利分数", value.kelly.fraction, (fraction) => {
              if (value.kelly && value.kelly.provenance !== "rolling-switch30")
                onChange({ ...value, kelly: { ...value.kelly, fraction } });
            })}
          <p className="text-sm text-muted-foreground">
            {value.kelly.provenance === "rolling-switch30"
              ? "本分区买入日前完整闭合不足30笔：原信号质量代理及四分之一凯利；达到30笔：净交易实测胜率及半凯利。零收益计非胜，同日卖出次日起计入，开发和验证分别累计；b保持人工假设。"
              : value.kelly.provenance === "breakout-quality"
                ? "按原入场信号五项判定映射假设胜率：3/4/5项为0.45/0.50/0.55；未知或不足3项不买入，加仓沿用原信号。不是实测胜率，b与分数为人工假设。"
                : value.kelly.provenance === "development-net-payoff"
                  ? "开发期关闭凯利作为参考，至少30笔完整闭合交易后，验证期固定使用胜率与净盈利/净亏损金额均值比。零收益计非胜但不进入盈亏均值；缺盈利或亏损样本则不买入，分数仍为人工假设。"
                  : value.kelly.provenance === "development-closed"
                    ? "开发期关闭凯利作为参考组合，至少30笔在验证前完整闭合后，固定胜率用于验证期；零收益计非胜。不足则验证期不买入，b与分数仍为人工假设。"
                    : "这些参数是整个研究区间的人工假设，不是实测胜率。"}
            分数0.5为半凯利、0.25为四分之一、1为全凯利；非正凯利停止买入，卖出照常。首仓和加仓后的单股总市值共同受限，并继续服从止损风险、仓位及成交约束。
          </p>
        </>
      )}
      <label>
        成交额容量约束
        <Select
          value={value.liquidityCap ? "on" : "off"}
          onValueChange={(raw) => {
            const { liquidityCap: _cap, ...rest } = value;
            onChange(raw === "off" ? rest : { ...rest, liquidityCap: true });
          }}
        >
          <SelectTrigger aria-label="成交额容量约束">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">关闭</SelectItem>
            <SelectItem value="on">前20日平均成交额的1%</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.liquidityCap && (
        <p className="text-xs text-muted-foreground">
          按买入前20个连续交易日成交额（元）限制单股总持仓市值，首仓和加仓共同受限。
          数据不足暂停买入，卖出照常；容量下降不自动减仓。
        </p>
      )}
      <label>
        大盘MA20震荡空仓
        <Select
          value={value.marketChop ? "on" : "off"}
          onValueChange={(raw) => {
            const { marketChop: _chop, ...rest } = value;
            onChange(
              raw === "off"
                ? rest
                : {
                    ...rest,
                    marketChop: { window: 10, minCrosses: 3, nearBand: 0.03 },
                  },
            );
          }}
        >
          <SelectTrigger aria-label="大盘MA20震荡空仓">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不启用</SelectItem>
            <SelectItem value="on">反复穿越时退出并暂停买入</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.marketChop && (
        <>
          {number("震荡观察交易日数", value.marketChop.window, (window) =>
            onChange({
              ...value,
              marketChop: { ...value.marketChop!, window },
            }),
          )}
          {number(
            "最少相邻穿越次数",
            value.marketChop.minCrosses,
            (minCrosses) =>
              onChange({
                ...value,
                marketChop: { ...value.marketChop!, minCrosses },
              }),
          )}
          {number(
            "距离MA20范围（%）",
            value.marketChop.nearBand,
            (nearBand) =>
              onChange({
                ...value,
                marketChop: { ...value.marketChop!, nearBand },
              }),
            100,
          )}
          <p className="text-sm text-muted-foreground">
            观察窗口内每个收盘均在范围内，且相邻日跨线达到次数才判震荡；恰好触线不计。只用前日及以前数据。震荡时退出持仓并暂停首仓和加仓，卖出受阻继续等待，入场期限不延长；窗口不再满足才恢复买入资格。缺连续有效数据仅暂停买入。默认10日、3次、上下3%是可调工程定义。
          </p>
        </>
      )}
      <label>
        连续三笔亏损冷静期
        <Select
          value={
            value.lossPauseDays == null ? "off" : String(value.lossPauseDays)
          }
          onValueChange={(raw) => {
            const { lossPauseDays: _days, ...rest } = value;
            onChange(
              raw === "off"
                ? rest
                : { ...rest, lossPauseDays: raw === "2" ? 2 : 1 },
            );
          }}
        >
          <SelectTrigger aria-label="连续三笔亏损冷静期">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不启用</SelectItem>
            <SelectItem value="1">休息接下来1个交易日</SelectItem>
            <SelectItem value="2">休息接下来2个交易日</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.lossPauseDays && (
        <p className="text-sm text-muted-foreground">
          按整笔完全平仓后的含费盈亏计数，分批卖出不重复计笔；零或盈利打断连亏。第三笔亏损结算后当日停止后续买入，再休息接下来的
          {value.lossPauseDays}个交易日。
          触发后计数从零重启，期间新三笔亏损可延长暂停，盈利不提前解禁。首仓和加仓暂停，卖出继续；待买原期限不延长。两研究分区分别计数，结算及暂停记录保存在结果。
        </p>
      )}
      <label>
        大盘MA20环境仓位
        <Select
          value={
            value.marketRegime ? String(value.marketRegime.weakWeight) : "off"
          }
          onValueChange={(raw) => {
            const { marketRegime: _regime, ...rest } = value;
            onChange(
              raw === "off"
                ? rest
                : {
                    ...rest,
                    marketRegime: {
                      kind: "ma20",
                      neutralBand: value.marketRegime?.neutralBand ?? 0.01,
                      weakWeight: raw === "0.3" ? 0.3 : 0,
                    },
                  },
            );
          }}
        >
          <SelectTrigger aria-label="大盘MA20环境仓位">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不启用</SelectItem>
            <SelectItem value="0">强60% / 中30% / 弱禁新仓</SelectItem>
            <SelectItem value="0.3">强60% / 中30% / 弱30%</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.marketRegime && (
        <>
          {number(
            "MA20附近中性带（%）",
            value.marketRegime.neutralBand,
            (neutralBand) =>
              onChange({
                ...value,
                marketRegime: { ...value.marketRegime!, neutralBand },
              }),
            100,
          )}
          <p className="text-sm text-muted-foreground">
            只用前一交易日已完成的上证基准：收盘高于MA20中性带且MA20上升为强，低于中性带且下降为弱，其余为中性。默认1%中性带是工程参数。
            需要按快照日历连续21根有效基准日线，缺失暂停首仓和加仓；限制与其他总仓上限取小，已有仓位继续原退出，不强制平仓。每日分类、参考日期、均线及缺失原因进入结果。
          </p>
        </>
      )}
      {(
        [
          ["maxInitialStopDistance", "初始止损距离准入上限", 0.05],
          ["maxTotalWeight", "组合总仓位上限", 0.6],
        ] as const
      ).map(([key, label, fallback]) => (
        <div key={key} className="space-y-2">
          <label>
            {label}
            <Select
              value={value[key] == null ? "off" : "on"}
              onValueChange={(raw) => {
                const next = { ...value };
                if (raw === "on") next[key] = fallback;
                else delete next[key];
                onChange(next);
              }}
            >
              <SelectTrigger aria-label={label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">不启用</SelectItem>
                <SelectItem value="on">启用</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {value[key] != null &&
            number(
              `${label}（%）`,
              value[key]!,
              (amount) => onChange({ ...value, [key]: amount }),
              100,
            )}
        </div>
      ))}
      {(value.maxInitialStopDistance != null ||
        value.maxTotalWeight != null) && (
        <p className="text-sm text-muted-foreground">
          止损距离按实际拟成交价检查，超过上限取消首仓，保留原止损位置。总仓位限制首仓及加仓，与加仓模式上限取较小值；保守预算计入买入费用。持仓涨价超限时停止新买入，已有仓位继续原退出规则。
        </p>
      )}
      <label>
        分批入场
        <Select
          value={
            pullback
              ? pullback.requireProfit
                ? "pullback-profit"
                : "pullback"
              : value.pyramid
                ? "pyramid"
                : "off"
          }
          onValueChange={(kind) => {
            const { pyramid: _pyramid, ...rest } = value;
            onChange(
              kind === "pyramid"
                ? {
                    ...rest,
                    pyramid: { kind: "r-50-30-20", maxTotalWeight: 0.6 },
                  }
                : kind === "pullback" || kind === "pullback-profit"
                  ? {
                      ...rest,
                      pyramid: {
                        kind: "pullback-50-50",
                        maxTotalWeight: 0.6,
                        waitBars: 1,
                        tolerance: 0.005,
                        requireProfit: kind === "pullback-profit",
                      },
                    }
                  : rest,
            );
          }}
        >
          <SelectTrigger aria-label="分批入场">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不加仓</SelectItem>
            <SelectItem value="pyramid">50/30/20 · 1R/2R盈利加仓</SelectItem>
            {allowStructure && (
              <>
                <SelectItem value="pullback">50/50 · 计划回踩分批</SelectItem>
                <SelectItem value="pullback-profit">
                  50/50 · 回踩且仍盈利
                </SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
      </label>
      {value.pyramid && (
        <>
          {number(
            "加仓组合总仓位上限（%）",
            value.pyramid.maxTotalWeight,
            (maxTotalWeight) =>
              onChange({
                ...value,
                pyramid: { ...value.pyramid!, maxTotalWeight },
              }),
            100,
          )}
          {pullback ? (
            <>
              {number(
                "回踩确认期限（信号后根数）",
                pullback.waitBars,
                (waitBars) =>
                  onChange({ ...value, pyramid: { ...pullback, waitBars } }),
              )}
              {number(
                "回踩触及容差（%）",
                pullback.tolerance,
                (tolerance) =>
                  onChange({ ...value, pyramid: { ...pullback, tolerance } }),
                100,
              )}
              <p className="text-xs text-muted-foreground md:col-span-2">
                首仓计划量50%，第二笔目标等于首仓实际股数，受资金和申报约束可不足。突破位在信号时冻结，默认只等次根；最低价触及容差范围且不破位，收盘确认后下一开盘补入。
                {pullback.requireProfit
                  ? "确认和成交都须为含买入费用的盈利头寸。"
                  : "计划分批允许第二笔价格低于首价，属于交易系统的50/50变体，不属于仅盈利递减金字塔。"}
                第二笔止损至少抬至冻结位且不降低原线，整体风险不超过首仓冻结预算；减仓或退出优先且停止补入，逐批T+1。缺失、破位或确认超时只取消剩余计划，首仓继续原风控。
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground md:col-span-2">
              按首仓冻结的计划总股数分批，数量递减并向下取整。收盘达到1R/2R后等待下一开盘，仍盈利才加仓；
              第二笔重算整体含费保本线，第三笔至少首仓成本，已有止损不下调。
              减仓或全退出优先，开始减仓后不再加仓；减仓比例以实际累计买入量为基数。
              跳空和成交受阻仍可突破风险预算。
            </p>
          )}
        </>
      )}
      <label>
        初始止损定位
        <Select
          value={value.stop.kind}
          onValueChange={(kind) =>
            onChange({
              ...value,
              stop:
                (kind === "breakout-candle" || kind === "platform-upper") &&
                allowStructure
                  ? { kind, buffer: kind === "breakout-candle" ? 0 : 0.005 }
                  : kind === "atr"
                    ? { kind, period: 14, multiple: 2 }
                    : kind === "structure" && allowStructure
                      ? { kind, buffer: 0.005 }
                      : kind === "structure-atr" && allowStructure
                        ? { kind, period: 14, multiple: 0.3 }
                        : (kind === "max-distance" ||
                              kind === "nearest-stop") &&
                            allowStructure
                          ? {
                              kind,
                              period: 14,
                              multiple: 1.5,
                              fraction: 0.05,
                              structureBuffer: 0.3,
                            }
                          : kind === "structure-auto" && allowStructure
                            ? {
                                kind,
                                atrPeriod: 14,
                                atrMultiple: 0.3,
                                percentBuffer: 0.005,
                              }
                            : { kind: "percent", fraction: 0.05 },
            })
          }
        >
          <SelectTrigger aria-label="初始止损定位">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="percent">入场价百分比</SelectItem>
            <SelectItem value="atr">信号日 ATR 距离</SelectItem>
            {allowStructure && (
              <SelectItem value="structure-auto">
                结构缓冲按ATR是否提供切换
              </SelectItem>
            )}
            {allowStructure && (
              <>
                <SelectItem value="breakout-candle">突破K线低点</SelectItem>
                <SelectItem value="platform-upper">突破前平台上沿</SelectItem>
                <SelectItem value="max-distance">三方案最大止损距离</SelectItem>
                <SelectItem value="nearest-stop">三方案近端止损优先</SelectItem>
              </>
            )}
            {allowStructure && (
              <SelectItem value="structure-atr">
                信号结构位减 ATR 缓冲
              </SelectItem>
            )}
            {allowStructure && (
              <SelectItem value="structure">信号结构位加缓冲</SelectItem>
            )}
          </SelectContent>
        </Select>
      </label>
      <label>
        显式止损覆盖
        <Select
          value={value.stopOverride ? "on" : "off"}
          onValueChange={(raw) => {
            const { stopOverride: _override, ...rest } = value;
            onChange(
              raw === "off"
                ? rest
                : {
                    ...rest,
                    stopOverride: {
                      symbol: "",
                      observedDate: "",
                      price: 0,
                      provenance: "manual-scenario",
                    },
                  },
            );
          }}
        >
          <SelectTrigger aria-label="显式止损覆盖">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不覆盖</SelectItem>
            <SelectItem value="on">绑定证券与信号日的人工实验</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.stopOverride && (
        <>
          <label>
            覆盖证券代码
            <Input
              aria-label="覆盖证券代码"
              placeholder="sh600000"
              value={value.stopOverride.symbol}
              onChange={(e) =>
                onChange({
                  ...value,
                  stopOverride: {
                    ...value.stopOverride!,
                    symbol: e.target.value,
                  },
                })
              }
            />
          </label>
          <label>
            覆盖信号观察日
            <Input
              aria-label="覆盖信号观察日"
              type="date"
              value={value.stopOverride.observedDate}
              onChange={(e) =>
                onChange({
                  ...value,
                  stopOverride: {
                    ...value.stopOverride!,
                    observedDate: e.target.value,
                  },
                })
              }
            />
          </label>
          {number("显式止损价格", value.stopOverride.price, (price) =>
            onChange({
              ...value,
              stopOverride: { ...value.stopOverride!, price },
            }),
          )}
          <p className="text-sm text-muted-foreground">
            仅覆盖证券代码与信号观察日均匹配的事件，其他事件沿用原定位。这是人工实验假设，不是已核实的历史记录；距离与风险门槛继续生效。
          </p>
        </>
      )}
      {value.stop.kind === "structure-auto" && (
        <>
          <label>
            结构缓冲ATR输入
            <Select
              value={value.stop.atrPeriod == null ? "none" : "provided"}
              onValueChange={(raw) => {
                if (value.stop.kind !== "structure-auto") return;
                const { atrPeriod: _period, ...stop } = value.stop;
                onChange({
                  ...value,
                  stop: raw === "none" ? stop : { ...stop, atrPeriod: 14 },
                });
              }}
            >
              <SelectTrigger aria-label="结构缓冲ATR输入">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="provided">提供信号日ATR</SelectItem>
                <SelectItem value="none">未提供ATR，使用百分比缓冲</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {value.stop.atrPeriod != null &&
            number("结构缓冲ATR周期", value.stop.atrPeriod, (atrPeriod) => {
              if (value.stop.kind === "structure-auto")
                onChange({ ...value, stop: { ...value.stop, atrPeriod } });
            })}
          {number(
            "提供ATR时的缓冲倍数",
            value.stop.atrMultiple,
            (atrMultiple) => {
              if (value.stop.kind === "structure-auto")
                onChange({ ...value, stop: { ...value.stop, atrMultiple } });
            },
          )}
          {number(
            "未提供ATR时的缓冲（%）",
            value.stop.percentBuffer,
            (percentBuffer) => {
              if (value.stop.kind === "structure-auto")
                onChange({ ...value, stop: { ...value.stop, percentBuffer } });
            },
            100,
          )}
          <p className="text-sm text-muted-foreground">
            已提供ATR但窗口不足或数值无效时不入场。未提供ATR时才按结构价百分比缓冲；结构和ATR取信号日证据。
          </p>
        </>
      )}
      {value.stop.kind === "percent" &&
        number(
          "初始止损距离（%）",
          value.stop.fraction,
          (fraction) =>
            onChange({ ...value, stop: { kind: "percent", fraction } }),
          100,
        )}
      {(value.stop.kind === "max-distance" ||
        value.stop.kind === "nearest-stop") && (
        <>
          {number(
            "候选百分比距离（%）",
            value.stop.fraction,
            (fraction) => {
              if (
                value.stop.kind === "max-distance" ||
                value.stop.kind === "nearest-stop"
              )
                onChange({ ...value, stop: { ...value.stop, fraction } });
            },
            100,
          )}
          {number(
            "候选结构缓冲ATR倍数",
            value.stop.structureBuffer,
            (structureBuffer) => {
              if (
                value.stop.kind === "max-distance" ||
                value.stop.kind === "nearest-stop"
              )
                onChange({
                  ...value,
                  stop: { ...value.stop, structureBuffer },
                });
            },
          )}
          <p className="text-sm text-muted-foreground">
            {value.stop.kind === "nearest-stop"
              ? "百分比、入场价减ATR、信号结构位减ATR缓冲三项取最高合法止损价。同一收盘确认规则下优先近端；不是盘中触碰或不同触发时段混合。"
              : "百分比、入场价减ATR、信号结构位减ATR缓冲三项取最低止损价。"}
            结构沿用双突破摆动低点或平台下沿；缺任一输入或候选无效则不入场。
            选中距离用于风险股数计算，仍服从仓位上限；两种选线分别对照。
          </p>
        </>
      )}
      {(value.stop.kind === "breakout-candle" ||
        value.stop.kind === "platform-upper") && (
        <>
          {number(
            "突破定位下方缓冲（%）",
            value.stop.buffer,
            (buffer) => {
              if (
                value.stop.kind === "breakout-candle" ||
                value.stop.kind === "platform-upper"
              )
                onChange({ ...value, stop: { ...value.stop, buffer } });
            },
            100,
          )}
          <p className="text-sm text-muted-foreground">
            突破K线低点在信号收盘后冻结；平台上沿仅选本次从下方突破且此前已确认的平台，优先最近确认者。默认低点不加缓冲，平台下方0.5%为工程参数；缺对应证据不入场，实际成交价必须高于止损。
          </p>
        </>
      )}
      {value.stop.kind === "structure" &&
        number(
          "结构位下方缓冲（%）",
          value.stop.buffer,
          (buffer) =>
            onChange({ ...value, stop: { kind: "structure", buffer } }),
          100,
        )}
      {value.stop.kind === "structure-atr" && (
        <label>
          结构止损最大ATR距离
          <Select
            value={value.stop.maxDistanceAtr ? "2" : "off"}
            onValueChange={(raw) => {
              if (value.stop.kind !== "structure-atr") return;
              const { maxDistanceAtr: _max, ...stop } = value.stop;
              onChange({
                ...value,
                stop: raw === "2" ? { ...stop, maxDistanceAtr: 2 } : stop,
              });
            }}
          >
            <SelectTrigger aria-label="结构止损最大ATR距离">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">不启用</SelectItem>
              <SelectItem value="2">超过2倍信号ATR取消入场</SelectItem>
            </SelectContent>
          </Select>
        </label>
      )}
      {value.stop.kind === "structure-atr" && (
        <p className="text-sm text-muted-foreground">
          信号结构位减信号日ATR缓冲，默认14周期、0.3倍。结构沿用双突破的摆动低点或平台下沿；不是入场价减ATR。缺任一输入不入场，缓冲后距离用于含费风险仓位。
        </p>
      )}
      {(value.stop.kind === "atr" ||
        value.stop.kind === "structure-atr" ||
        value.stop.kind === "max-distance" ||
        value.stop.kind === "nearest-stop") && (
        <>
          {number("初始 ATR 周期", value.stop.period, (period) => {
            if (
              value.stop.kind === "atr" ||
              value.stop.kind === "structure-atr" ||
              value.stop.kind === "max-distance" ||
              value.stop.kind === "nearest-stop"
            )
              onChange({ ...value, stop: { ...value.stop, period } });
          })}
          {number("初始 ATR 倍数", value.stop.multiple, (multiple) => {
            if (
              value.stop.kind === "atr" ||
              value.stop.kind === "structure-atr" ||
              value.stop.kind === "max-distance" ||
              value.stop.kind === "nearest-stop"
            )
              onChange({ ...value, stop: { ...value.stop, multiple } });
          })}
        </>
      )}
      <label>
        止损确认
        <Select
          value={String(value.confirmations)}
          onValueChange={(raw) =>
            onChange({ ...value, confirmations: raw === "2" ? 2 : 1 })
          }
        >
          <SelectTrigger aria-label="止损确认">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">一根收盘失守</SelectItem>
            <SelectItem value="2">连续两根收盘失守</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {number(
        "仓位压力缓冲（止损位下方%）",
        value.stressBuffer,
        (stressBuffer) => onChange({ ...value, stressBuffer }),
        100,
      )}
      <label>
        持仓止损演化
        <Select
          value={value.trail.kind}
          onValueChange={(kind) =>
            onChange({
              ...value,
              trail:
                kind === "percent"
                  ? { kind, fraction: 0.08 }
                  : kind === "distance"
                    ? { kind, distance: 1 }
                    : kind === "chandelier" || kind === "rolling-chandelier"
                      ? { kind, period: 22, multiple: 3 }
                      : kind === "close-atr"
                        ? { kind, period: 14, multiple: 2 }
                        : kind === "retracement"
                          ? { kind }
                          : { kind: "fixed" },
              ...(kind === "fixed" ? { trailAfterScaleOut: undefined } : {}),
            })
          }
        >
          <SelectTrigger aria-label="持仓止损演化">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">初始位置不动</SelectItem>
            <SelectItem value="percent">持仓最高价百分比跟随</SelectItem>
            <SelectItem value="distance">持仓最高价固定价差跟随</SelectItem>
            <SelectItem value="chandelier">持仓最高价吊灯 ATR 跟随</SelectItem>
            <SelectItem value="rolling-chandelier">
              窗口最高价吊灯 ATR 跟随
            </SelectItem>
            <SelectItem value="close-atr">收盘价减 ATR 跟随</SelectItem>
            <SelectItem value="retracement">利润回吐分级收紧</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.trail.kind === "rolling-chandelier" && (
        <p className="text-sm text-muted-foreground">
          使用最近完整窗口最高价减ATR倍数，默认22根、3倍；窗口包括入场前历史，与持仓以来最高价不同。收盘更新后次日起生效，仅上移；旧高点移出窗口不降低已有止损。数据不足或无效时保留原线并记录原因。
        </p>
      )}
      {value.trail.kind === "retracement" && (
        <p className="text-sm text-muted-foreground">
          以首仓成交价和初始止损冻结1R，持仓最高价达到2R/3R/4R/7R后分别允许回吐最高价格浮盈的30%/25%/20%/5%。未达2R保留原线；收盘更新后下一交易日起生效，只升不降，按所选收盘确认退出。分批和加仓不重置首仓R，已实现利润不计入此价格浮盈；费用和跳空可能使实际收益不同。
        </p>
      )}
      {value.trail.kind === "distance" && (
        <>
          {number(
            "固定跟随价差（行情价格单位）",
            value.trail.distance,
            (distance) =>
              onChange({ ...value, trail: { kind: "distance", distance } }),
          )}
          <p className="text-sm text-muted-foreground">
            持仓最高价减固定价差，默认1个价格单位是工程参数，与百分比或ATR不同。收盘更新后次日起生效，只升不降；不同价格水平的股票需分别评估价差参数。加仓和分批减仓不重置最高锚点。
          </p>
        </>
      )}
      {value.trail.kind === "percent" &&
        number(
          "移动止损距离（%）",
          value.trail.fraction,
          (fraction) =>
            onChange({ ...value, trail: { kind: "percent", fraction } }),
          100,
        )}
      {(value.trail.kind === "chandelier" ||
        value.trail.kind === "rolling-chandelier" ||
        value.trail.kind === "close-atr") && (
        <>
          {number("移动 ATR 周期", value.trail.period, (period) => {
            if (
              value.trail.kind === "chandelier" ||
              value.trail.kind === "rolling-chandelier" ||
              value.trail.kind === "close-atr"
            )
              onChange({ ...value, trail: { ...value.trail, period } });
          })}
          {number("移动 ATR 倍数", value.trail.multiple, (multiple) => {
            if (
              value.trail.kind === "chandelier" ||
              value.trail.kind === "rolling-chandelier" ||
              value.trail.kind === "close-atr"
            )
              onChange({ ...value, trail: { ...value.trail, multiple } });
          })}
        </>
      )}
      {value.scaleOut && value.trail.kind !== "fixed" && (
        <label>
          移动止损启动
          <Select
            value={value.trailAfterScaleOut ? "after" : "entry"}
            onValueChange={(raw) =>
              onChange({ ...value, trailAfterScaleOut: raw === "after" })
            }
          >
            <SelectTrigger aria-label="移动止损启动">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="entry">入场后开始</SelectItem>
              <SelectItem value="after">全部减仓档实际成交后</SelectItem>
            </SelectContent>
          </Select>
        </label>
      )}
      <label>
        保本触发
        <Select
          value={
            value.breakeven?.mode === "r-only"
              ? "r-only"
              : value.breakeven
                ? "enabled"
                : "disabled"
          }
          onValueChange={(raw) => {
            const { breakeven: _breakeven, ...base } = value;
            onChange(
              raw === "enabled"
                ? { ...base, breakeven: { atR: 1 } }
                : raw === "r-only"
                  ? { ...base, breakeven: { atR: 1, mode: "r-only" } }
                  : base,
            );
          }}
        >
          <SelectTrigger aria-label="保本触发">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">不启用</SelectItem>
            <SelectItem value="enabled">浮盈和更高低点均确认后</SelectItem>
            <SelectItem value="r-only">仅收盘达到指定R</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value.breakeven && (
        <>
          {number("保本最低浮盈R", value.breakeven.atR, (atR) =>
            onChange({ ...value, breakeven: { ...value.breakeven, atR } }),
          )}
          <p className="text-sm text-muted-foreground">
            {value.breakeven.mode === "r-only"
              ? "收盘达到首仓价加指定初始R后，下一交易日起移至首仓成交价。无需等待更高低点，不使用当日最高价回溯触发；不保证覆盖费用或跳空。"
              : "近60根日线的摆动低点须经右侧3根确认。最近低点须发生在入场后，并高于前低点和成交价；不跨歧义K线或停牌。达到浮盈门槛后才移至成交价，从下一交易日起生效，不保证覆盖费用或跳空。"}
          </p>
        </>
      )}
      <label>
        时间退出
        <Select
          value={value.timeExit ? "enabled" : "disabled"}
          onValueChange={(raw) =>
            onChange({
              ...value,
              timeExit: raw === "enabled" ? { days: 5, minR: 0.5 } : null,
            })
          }
        >
          <SelectTrigger aria-label="时间退出">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">
              {value.progressExit
                ? "未启用额外R值时间退出"
                : "仅使用最长持有期"}
            </SelectItem>
            <SelectItem value="enabled">规定时间后进展不足则退出</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label>
        分批止盈
        <Select
          value={value.scaleOut ? "enabled" : "disabled"}
          onValueChange={(raw) => {
            const {
              scaleOut: _scaleOut,
              trailAfterScaleOut: _trailAfterScaleOut,
              ...base
            } = value;
            onChange(
              raw === "enabled"
                ? {
                    ...base,
                    scaleOut: researchScaleOutPreset.map((row) => ({ ...row })),
                  }
                : base,
            );
          }}
        >
          <SelectTrigger aria-label="分批止盈">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">不分批卖出</SelectItem>
            <SelectItem value="enabled">按初始风险R分档卖出</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <Button
        type="button"
        variant="outline"
        className="h-auto whitespace-normal"
        onClick={() => onChange(researchRManagementTemplate(value))}
      >
        应用1R保本、2R减半与22周期3ATR尾仓
      </Button>
      {researchExitPresetIds.map((kind) => (
        <Button
          key={kind}
          type="button"
          variant="outline"
          className="h-auto whitespace-normal"
          onClick={() => onChange(researchExitPresetTemplate(value, kind))}
        >
          应用{researchExitPresetLabels[kind]}
        </Button>
      ))}
      {value.exitPreset && (
        <p className="text-sm text-muted-foreground">
          当前退出预设：{researchExitPresetLabels[value.exitPreset]}。
          {isCanslimProgressPreset(value.exitPreset)
            ? researchProgressExitDescription
            : isCanslimExitPreset(value.exitPreset)
              ? canslimExitDescription
              : value.exitPreset === "half-2r-tail"
                ? "半仓按数量规则实际卖出后才启动尾仓，不额外保本或抬至1R。"
                : value.exitPreset === "trail-only"
                  ? "不设固定止盈目标，入场后按窗口吊灯跟随。"
                  : "收盘达到目标后，下一可成交开盘退出全部仓位；没有提前保本或移动线。"}
          初始止损、信号退出、时间退出和最长持有仍有效。
        </p>
      )}
      {isResearchRManagementTemplate(value) && (
        <p className="text-sm text-muted-foreground">
          R管理组合：收盘1R保本，2R触发减半，按数量规则完成减仓后抬至1R，
          再启动22周期窗口最高价减3ATR尾仓线。保留初始定位与时间退出，
          实际卖出受T+1及成交约束，未完成减仓不启动尾仓。
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          onChange({
            ...value,
            scaleOut: researchScaleOutPreset.map((row) => ({ ...row })),
            trail: { kind: "close-atr", period: 14, multiple: 2 },
            trailAfterScaleOut: true,
          })
        }
      >
        应用2R/4R减仓与末档后2ATR尾仓模板
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto whitespace-normal"
        onClick={() => onChange(swingExitTemplate(value, false))}
      >
        应用1R/2R各减三分之一
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto whitespace-normal"
        onClick={() => onChange(swingExitTemplate(value, true))}
      >
        应用1R/2R减仓与前目标尾仓
      </Button>
      {swingExitKind(value) && (
        <p className="text-sm text-muted-foreground">
          波段模板：首价与初始止损冻结1R，两档各卖三分之一，第一档不抬线。
          {swingExitKind(value) === "prior-target"
            ? "第二档实际完成后，剩余止损抬至第一目标1R；收盘触及或跌破后下一可成交开盘退出。"
            : "两档后剩余仓位继续原初始止损。"}
          模板保留初始止损与时间退出，改为一根收盘确认，关闭其他移动线和结构保本；所选策略反向退出及最长持有仍有效。
        </p>
      )}
      {value.scaleOut?.map((row, index) => (
        <fieldset key={index} className="space-y-2 rounded-md border p-3">
          <legend>第{index + 1}档</legend>
          {number(`第${index + 1}档触发R`, row.atR, (atR) =>
            onChange({
              ...value,
              scaleOut: value.scaleOut!.map((item, i) =>
                i === index ? { ...item, atR } : item,
              ),
            }),
          )}
          {number(
            `第${index + 1}档卖出初始仓位（%）`,
            row.fraction,
            (fraction) =>
              onChange({
                ...value,
                scaleOut: value.scaleOut!.map((item, i) =>
                  i === index ? { ...item, fraction } : item,
                ),
              }),
            100,
          )}
          <label>
            成交后止损
            <Select
              value={row.raiseStopR == null ? "keep" : "raise"}
              onValueChange={(raw) =>
                onChange({
                  ...value,
                  scaleOut: value.scaleOut!.map((item, i) =>
                    i === index
                      ? { ...item, raiseStopR: raw === "keep" ? null : 0 }
                      : item,
                  ),
                })
              }
            >
              <SelectTrigger aria-label={`第${index + 1}档成交后止损`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">保持原线</SelectItem>
                <SelectItem value="raise">抬升到入场价加指定R</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {row.raiseStopR != null &&
            number(`第${index + 1}档抬升至R`, row.raiseStopR, (raiseStopR) =>
              onChange({
                ...value,
                scaleOut: value.scaleOut!.map((item, i) =>
                  i === index ? { ...item, raiseStopR } : item,
                ),
              }),
            )}
          <Button
            type="button"
            variant="outline"
            disabled={value.scaleOut!.length === 1}
            onClick={() =>
              onChange({
                ...value,
                scaleOut: value.scaleOut!.filter((_, i) => i !== index),
              })
            }
          >
            删除第{index + 1}档
          </Button>
        </fieldset>
      ))}
      {value.scaleOut && (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={value.scaleOut.length >= 8}
            onClick={() =>
              onChange({
                ...value,
                scaleOut: [
                  ...value.scaleOut!,
                  {
                    atR: value.scaleOut!.at(-1)!.atR + 2,
                    fraction: 0.1,
                    raiseStopR: null,
                  },
                ],
              })
            }
          >
            增加止盈档位
          </Button>
          <p className="text-sm text-muted-foreground">
            每档按初始买入股数计算，比例合计不超过100%，按有效卖出数量向下取整。收盘达到目标后下一可成交开盘卖出，实际完成该档减仓才抬升止损；每根收盘最多触发一档。止损或到期全退出优先。须在交易条件文件提供minimumSell、sellStep、maximumSell、sellOddLotAll，否则不执行分批策略。跳空可能使实际卖价低于目标；模板不保证锁定收益。
          </p>
        </>
      )}
      {value.progressExit && (
        <div className="space-y-2 text-sm">
          <p>
            价格进展检查：
            {value.progressExit.clock === "calendar-days"
              ? "自然日"
              : "交易日（含入场日）"}{" "}
            {value.progressExit.days} 天，最低涨幅{" "}
            {value.progressExit.minimumGain * 100}
            %。到期首个有效收盘检查一次，缺失顺延并保留原到期日。
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const { progressExit: _progress, ...rest } = value;
              onChange(rest);
            }}
          >
            移除价格进展检查
          </Button>
        </div>
      )}
      {value.timeExit && (
        <>
          {number("进展观察交易日（含入场日）", value.timeExit.days, (days) => {
            if (value.timeExit)
              onChange({ ...value, timeExit: { ...value.timeExit, days } });
          })}
          {number(
            "最低收盘进展（初始止损距离R）",
            value.timeExit.minR,
            (minR) => {
              if (value.timeExit)
                onChange({ ...value, timeExit: { ...value.timeExit, minR } });
            },
          )}
        </>
      )}
      <p className="text-sm text-muted-foreground">
        ATR
        使用完整窗口真实波幅的算术均值。收盘触发后下一可成交开盘退出；停牌或缺价打断连续确认。移动线只上移，收盘更新后下一交易日生效。
        {pullback
          ? "压力缓冲用于两笔合计风险估算；止损至少抬至冻结突破位，不保证保本或最大亏损。"
          : value.pyramid
            ? "压力缓冲用于仓位及加仓整体保本估算，可要求更高止损线，不保证最大亏损。"
            : "压力缓冲只缩小仓位，不改变触发线，也不保证最大亏损。"}
        最长持有期仍有效。
      </p>
    </>
  );
}

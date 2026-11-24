import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DiagnoseCell,
  DiagnoseComparison,
  UniversePoolDisclosure,
} from "./types";

const escapeCell = (value: string) =>
  value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const cellLabel = (cell: DiagnoseCell) =>
  `${cell.mode}/${cell.strategy}/${cell.symbols.join("+")}`;
const strategyLabel = (cell: DiagnoseCell, row: { strategyKey?: string }) =>
  row.strategyKey ? `${cellLabel(cell)} · ${row.strategyKey}` : cellLabel(cell);

function markdownTable(header: string[], rows: (string | number)[][]) {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${row.map((value) => escapeCell(String(value))).join(" | ")} |`,
    ),
  ].join("\n");
}

function poolSection(pool: UniversePoolDisclosure) {
  const lines = [
    "## 样本池与口径披露",
    "",
    `- 样本池：\`${pool.id}\` · ${pool.label}`,
    `- 预设成员数：${pool.symbolCount}`,
    "",
    `> ${pool.survivorBiasDisclosure}`,
  ];
  if (pool.overlapWithCore12)
    lines.push(
      "",
      `与 core-12 重叠 ${pool.overlapWithCore12.count} 股（${pool.overlapWithCore12.symbols.join("、") || "无"}）。`,
    );
  if (pool.members?.length) {
    lines.push(
      "",
      markdownTable(
        ["标的", "名称", "分组", "板块", "验证用途"],
        pool.members.map(({ symbol, name, group, board, role }) => [
          symbol,
          name,
          group,
          board,
          role,
        ]),
      ),
    );
  }
  return lines.join("\n");
}

function table(cells: readonly DiagnoseCell[]) {
  const header = [
    "策略",
    "标的",
    "状态",
    "层",
    "bars",
    "signals",
    "orders",
    "fills",
    "拒绝",
    "平仓",
    "主要拒绝原因",
    "发现",
  ];
  const rows = cells.map((cell) => [
    cell.strategy,
    cell.symbols.join("+"),
    cell.error ? `${cell.status}: ${cell.error}` : cell.status,
    cell.layer ?? "",
    String(cell.counts.bars),
    String(cell.counts.signals),
    String(cell.counts.orders),
    String(cell.counts.fills),
    String(cell.counts.rejections),
    String(cell.counts.closedTrades),
    (cell.rejectionReasons ?? [])
      .slice(0, 3)
      .map((row) => `${row.reason}×${row.count}`)
      .join("；"),
    cell.findings.slice(0, 3).join("；"),
  ]);
  return markdownTable(header, rows);
}

function issueSection(cells: readonly DiagnoseCell[]) {
  const p0: string[] = [],
    p1: string[] = [],
    p2: string[] = [];
  for (const cell of cells) {
    const label = cellLabel(cell);
    if (cell.status === "failed" && cell.error)
      p0.push(`- ${label}：${cell.error}`);
    if (cell.status === "blocked")
      p2.push(
        `- ${label}：阻断（${cell.layer ?? "data"}）${cell.error ?? ""}`.trim(),
      );
    const checks = cell.checks ?? [];
    const messages = new Set(checks.map((check) => check.message));
    for (const check of checks) {
      if (check.status === "fail")
        p0.push(`- ${label}：${check.id} — ${check.message}`);
      else if (check.status === "warn")
        p1.push(`- ${label}：${check.id} — ${check.message}`);
    }
    for (const finding of cell.findings)
      if (!messages.has(finding)) p2.push(`- ${label}：${finding}`);
  }
  const section = (title: string, rows: string[]) =>
    [title, "", ...(rows.length ? [...new Set(rows)] : ["- 无"])].join("\n");
  return [
    section("### P0（正确性失败）", p0),
    section("### P1（告警/数据限制）", p1),
    section("### P2（阻断与未验证边界）", p2),
  ].join("\n\n");
}

/**
 * Native Chan rows carry the DLL/api identity and capture scale each cell ran
 * against. The full DLL hash is printed so an auditor can match the artifact
 * build exactly rather than trusting a shortened prefix.
 */
function nativeSection(cells: readonly DiagnoseCell[]) {
  const rows = cells.flatMap((cell) =>
    (cell.nativeChan ?? []).map((row) => ({ cell, row })),
  );
  if (!rows.length) return "";
  const header = [
    "单元",
    "标的",
    "firstIndex",
    "projectionVersion",
    "dllHash",
    "apiVersion",
    "buildCommit",
    "configId",
    "config / anchor",
    "起点/基线",
    "前缀数",
    "cached",
    "captureElapsedMs",
    "缓存读取 ms",
    "审计/待确认",
    "信号价基",
  ];
  const body = rows.map(({ cell, row }) => [
    strategyLabel(cell, row),
    row.symbol,
    row.firstIndex,
    row.projectionVersion,
    row.dllHash,
    String(row.identity.apiVersion),
    row.identity.buildCommit,
    row.identity.configId,
    `${row.identity.config} / ${row.identity.anchor}`,
    `${row.originDate} / ${row.baselineDate}`,
    String(row.prefixCount),
    String(row.cached),
    row.captureMetricsAvailable ? row.captureElapsedMs : "未知",
    row.cacheLoadMs ?? "—",
    `${row.auditCount} / ${row.pendingCount}`,
    row.signalPriceBasis ?? "",
  ]);
  return [
    "## 原生引擎披露",
    "",
    "> 原生缠论结构由本机 DLL 生成；下表固定来源指纹、起点与前缀规模，供复核与复现。",
    "",
    markdownTable(header, body),
    ...rows.flatMap(({ row }) =>
      row.insufficientWarmup
        ? [
            `${row.symbol} 预热不足：已有 ${row.insufficientWarmup.availableBars} 根，需 ${row.insufficientWarmup.requiredWarmupBars} 根预热行情和一根观察行情。可用观察 0 根。`,
          ]
        : [],
    ),
  ].join("\n");
}

/**
 * Growth PIT rows expose how strict disclosure gating reduced the raw price
 * signals. The boundary quote comes from the disclosure itself so the report
 * cannot drift from the series semantics.
 */
function growthPitSection(cells: readonly DiagnoseCell[]) {
  const rows = cells.flatMap((cell) =>
    (cell.growthPit ?? cell.canslimPit ?? []).map((row) => ({ cell, row })),
  );
  if (!rows.length) return "";
  const header = [
    "单元",
    "标的",
    "strict 报告数",
    "报告期范围",
    "合格交易日",
    "缺失日",
    "负基数/冲突日",
    "价格触发数",
    "PIT 过滤后信号",
    "财务包问题数",
  ];
  const body = rows.map(({ cell, row }) => [
    strategyLabel(cell, row),
    row.symbol,
    String(row.strictReportCount),
    row.reportDateRange
      ? `${row.reportDateRange[0]} ~ ${row.reportDateRange[1]}`
      : "",
    String(row.qualifiedDays),
    String(row.missingDays),
    String(row.conflictDays),
    String(row.priceSignalCount),
    String(row.pitFilteredSignalCount),
    String(row.sourceIssuesCount),
  ]);
  return [
    "## 成长 PIT 财务披露",
    "",
    ...[...new Set(rows.map(({ row }) => row.boundary))].map(
      (boundary) => `> ${boundary}`,
    ),
    "",
    markdownTable(header, body),
    ...rows.flatMap(({ cell, row }) => {
      const { funnel, checkCoverage, sepaPit, marketRegime, exitAblation } =
        row;
      const exit =
        exitAblation === undefined
          ? `${row.maxBars} 根`
          : exitAblation.kind === "5-bar"
            ? "5 根"
            : exitAblation.kind === "fixed-stop"
              ? `${Math.round(exitAblation.fraction * 100)}% 固定止损`
              : `收盘跌破 MA${exitAblation.period}`;
      const ruleSuffix =
        row.ruleId && row.ruleId !== (row.strategyKey ?? cell.strategy)
          ? ` (${row.ruleId})`
          : "";
      const details = [
        "",
        `### ${row.strategyKey ?? cell.strategy}${ruleSuffix} · ${cell.mode} · ${row.symbol}`,
        "",
        `- 入场漏斗（价量 → 趋势/VCP → PIT 财务 → 大盘过滤后） ${funnel.priceSignals} → ${funnel.trendVcpSignals} → ${funnel.pitFinanceSignals} → ${funnel.marketRegimeSignals}`,
        `- 退出规则：${exit}`,
      ];
      if (row.exitSuppressedEntrySignals !== undefined)
        details.push(
          `- 同日退出优先抑制的入场信号：${row.exitSuppressedEntrySignals}`,
        );
      if (sepaPit)
        details.push(
          `- SEPA 交易日：严格通过 ${sepaPit.strictPassDays}，宽松通过 ${sepaPit.tolerantPassDays}，缺项 ${sepaPit.incompleteDays}，未通过 ${sepaPit.failedDays}`,
          `- 趋势/VCP 与财务同时通过：严格 ${funnel.strictPitFinanceSignals}，宽松 ${funnel.tolerantPitFinanceSignals}`,
        );
      if (marketRegime)
        details.push(
          `- CANSLIM M（${marketRegime.symbol}，截至 ${marketRegime.latestIndexDate ?? "无行情"}）：允许 ${marketRegime.allowedDays}，阻断 ${marketRegime.blockedDays}，未知 ${marketRegime.unknownDays}。输入摘要 \`${marketRegime.inputHash}\``,
        );
      for (const issue of row.duplicateIssues)
        details.push(
          `- 重复财报：${[issue.file, issue.reportDate, issue.message].filter(Boolean).join(" · ")}`,
        );
      if (checkCoverage)
        details.push(
          "",
          markdownTable(
            ["财务项", "可计算日", "缺失日", "冲突日", "通过日", "边际通过率"],
            Object.entries(checkCoverage).map(([id, c]) => [
              id,
              c.computed,
              c.missing,
              c.conflict,
              c.passed,
              c.marginalPassRate === null
                ? "—"
                : `${(c.marginalPassRate * 100).toFixed(1)}%`,
            ]),
          ),
        );
      return details;
    }),
  ].join("\n");
}

function wyckoffSection(cells: readonly DiagnoseCell[]) {
  const rows = cells.flatMap((cell) =>
    (cell.wyckoffFunnel ?? []).map((row) => ({ cell, row })),
  );
  if (!rows.length) return "";
  return [
    "## 威科夫入场漏斗",
    "",
    markdownTable(
      [
        "单元",
        "标的",
        "父事件可回踩日",
        "回踩缩量",
        "候选",
        "次日确认",
        "入场信号",
        "买单",
        "买入成交",
        "父事件确认",
        "跨窗口候选",
      ],
      rows.map(({ cell, row }) => [
        strategyLabel(cell, row),
        row.symbol,
        row.parentEvents,
        row.pullbackShrinkage,
        row.candidates,
        row.nextDayVolumeConfirm,
        row.entrySignals,
        row.buyOrders,
        row.buyFills,
        row.parentConfirmations,
        row.carryInCandidates,
      ]),
    ),
    "",
    ...[...new Set(rows.map(({ row }) => row.boundary))].map(
      (boundary) => `> ${boundary}`,
    ),
    ...rows.flatMap(({ cell, row }) =>
      row.nextDayBreakdown
        ? [
            "",
            `### ${strategyLabel(cell, row)} · ${row.symbol} 次日确认条件`,
            markdownTable(
              [
                "有次日行情",
                "守住候选低点",
                "突破候选高点",
                "量 ≥ 1.5 倍",
                "量 ≥ 1.0 倍",
                "次日有效",
                "两个价格条件均通过",
                "原四条件均通过",
              ],
              [
                [
                  row.nextDayBreakdown.candidatesWithNextBar,
                  row.nextDayBreakdown.holdCandidateLow,
                  row.nextDayBreakdown.closeAboveCandidateHigh,
                  row.nextDayBreakdown.volumeGe15xMean20,
                  row.nextDayBreakdown.volumeGe10xMean20,
                  row.nextDayBreakdown.validNextBarNoReason,
                  row.nextDayBreakdown.holdAndCloseAboveHigh,
                  row.nextDayBreakdown.allFourConfirmed,
                ],
              ],
            ),
          ]
        : [],
    ),
  ].join("\n");
}

const percent = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(3)}%`;
const metric = (v: number | null) => (v === null ? "—" : v.toFixed(4));

function attributionSection(cell: DiagnoseCell) {
  const a = cell.sleeveAttribution;
  if (!a) return [];
  return [
    `## 分仓归因 · ${cellLabel(cell)}`,
    "",
    `组合最大回撤 ${percent(a.maxDrawdown)}，峰值 ${a.peakDate}（${a.peakEquity.toFixed(2)}），谷值 ${a.troughDate}（${a.troughEquity.toFixed(2)}）。分仓贡献合计 ${percent(a.contributionSum)}。`,
    "",
    markdownTable(
      [
        "分仓",
        "期初权益",
        "期末权益",
        "账面收益",
        "账面最大回撤",
        "成交笔数",
        "平均权重",
        "峰谷回撤贡献",
      ],
      a.sleeves.map((s) => [
        s.id,
        s.initialEquity.toFixed(2),
        s.finalEquity.toFixed(2),
        percent(s.return),
        percent(s.maxDrawdown),
        s.trades,
        percent(s.averageWeight),
        percent(s.drawdownContribution),
      ]),
    ),
    "",
    "### 分仓日收益相关性",
    "",
    markdownTable(
      ["分仓 A", "分仓 B", "重叠日", "相关系数", "缺失原因"],
      a.correlations.map((pair) => [
        pair.left,
        pair.right,
        pair.overlap,
        metric(pair.correlation),
        pair.reason ?? "",
      ]),
    ),
    "",
    ...(cell.sleeveInvestment
      ? [
          markdownTable(
            [
              "分仓",
              "投资收益（剔除划转）",
              "投资最大回撤",
              "交易损益贡献（元）",
            ],
            cell.sleeveInvestment.sleeves.map((s) => [
              s.id,
              percent(s.investmentReturn),
              percent(s.investmentMaxDrawdown),
              s.tradingPnlContribution.toFixed(2),
            ]),
          ),
          "",
          "### 剔除划转的投资收益相关性",
          "",
          markdownTable(
            ["分仓 A", "分仓 B", "重叠日", "相关系数", "缺失原因"],
            cell.sleeveInvestment.correlations.map((p) => [
              p.left,
              p.right,
              p.overlap,
              metric(p.correlation),
              p.reason ?? "",
            ]),
          ),
          "",
        ]
      : []),
    a.transferBasis,
    "",
    ...(cell.bookControl
      ? [
          `分配政策 ${cell.bookControl.policy}，目标 ${cell.bookControl.targetCount} 次，现金划转 ${cell.bookControl.transferCount} 笔。`,
          ...(cell.bookControl.policy === "risk-parity-60"
            ? [
                "权重取自同一执行情景下无划转基线的历史分仓投资收益，在下一交易日调拨闲置现金。",
              ]
            : []),
          "",
        ]
      : []),
    ...(cell.sleeveTrades
      ? [
          "### 完整交易轮次与成本",
          "",
          markdownTable(
            [
              "分仓",
              "完整轮次",
              "胜率",
              "盈亏比",
              "利润因子",
              "持有交易日 P25/P50/P75/P90",
              "现金率",
              "单边换手",
              "佣金（元）",
              "印花税（元）",
              "过户费（元）",
              "滑点（元）",
              "滑点未知笔数",
            ],
            [
              { id: "组合", ...cell.sleeveTrades.portfolio },
              ...cell.sleeveTrades.sleeves,
            ].map((s) => [
              s.id,
              s.roundTrips,
              percent(s.winRate),
              metric(s.profitLossRatio),
              metric(s.profitFactor),
              [
                s.holdingPeriod.p25,
                s.holdingPeriod.p50,
                s.holdingPeriod.p75,
                s.holdingPeriod.p90,
              ]
                .map(metric)
                .join(" / "),
              percent(s.cashRatio),
              percent(s.oneSidedTurnover),
              metric(s.costs.commission),
              metric(s.costs.stampDuty),
              metric(s.costs.transferFee),
              metric(s.costs.slippage),
              s.costs.slippageMissingFills,
            ]),
          ),
          "",
        ]
      : []),
    "",
  ];
}

function holdoutSection(cell: DiagnoseCell) {
  const review = cell.timeHoldout;
  if (!review) return [];
  const { devSummary, devWindowRange, holdout, holdoutRange, statistics } =
    review;
  const legs = ["base", "doubledCost", "delayed"] as const;
  const lines = [
    `## 时间留出 · ${cellLabel(cell)}`,
    "",
    `${review.classification} · 切点 ${review.holdoutStart} · ${review.status} · ${review.passed ? "通过" : "未通过"}`,
    "",
    review.disclosure,
    "",
  ];
  if (devWindowRange && devSummary)
    lines.push(
      `### Dev 滚动窗 · ${devWindowRange.start} 至 ${devWindowRange.end}（共 ${devSummary.windowCount} 窗，通过风险调整标准的窗口数为 ${devSummary.positiveWindows}）`,
      "",
      markdownTable(
        ["情景", "平均收益", "平均夏普", "最差回撤", "交易数"],
        legs.map((leg) => {
          const s = devSummary[leg];
          return [
            leg,
            percent(s.meanReturn),
            metric(s.meanSharpe),
            percent(s.worstDrawdown),
            s.trades,
          ];
        }),
      ),
      "",
    );
  if (holdoutRange && holdout)
    lines.push(
      `### Holdout · ${holdoutRange.start} 至 ${holdoutRange.end}`,
      "",
      markdownTable(
        [
          "情景",
          "收益",
          "超额收益",
          "最大回撤",
          "夏普",
          "Calmar",
          "基准 Calmar",
          "Calmar 差值",
          "交易数",
          "费用",
        ],
        legs.map((leg) => {
          const s = holdout[leg];
          return [
            leg,
            percent(s.return),
            percent(s.excess),
            percent(s.drawdown),
            metric(s.sharpe),
            metric(s.calmar),
            metric(s.benchmarkCalmar),
            metric(s.calmarDifference),
            s.trades,
            s.fees.toFixed(2),
          ];
        }),
      ),
      "",
    );
  return [
    ...lines,
    markdownTable(
      ["DSR", "DSR 门槛", "PBO", "有效试验数"],
      [
        [
          metric(statistics.dsr),
          statistics.dsrThreshold,
          metric(statistics.pbo),
          statistics.effectiveTrials,
        ],
      ],
    ),
    "",
    statistics.note,
    "",
    ...review.reasons.map((reason) => `- ${reason}`),
    "",
  ];
}

function suspensionSection(cell: DiagnoseCell) {
  const evidence = cell.suspensionEvidence;
  if (!evidence) return [];
  const { symbolSuspensionDays, portfolioAffectedDays, certificates } =
    evidence;
  const lines = [
    `### 停牌证据 · ${cellLabel(cell)}`,
    "",
    `证券停牌日数 ${symbolSuspensionDays}，组合受影响日数 ${portfolioAffectedDays}。缺少认证的行情缺口按未知处理。`,
    "",
  ];
  if (certificates.length)
    lines.push(
      markdownTable(
        [
          "标的",
          "停牌日",
          "复牌日",
          "证据",
          "来源文件",
          "SHA-256",
          "记录位置",
          "生效日",
          "获知时间",
        ],
        certificates.flatMap((c) =>
          c.sources.map((s) => [
            c.symbol,
            c.date,
            c.resumptionDate,
            s.kind,
            s.sourcePath,
            s.sourceSha256,
            s.kind === "GP29" ? s.offset : s.recordId,
            s.effectiveDate,
            s.knownAt ?? "未知",
          ]),
        ),
      ),
      "",
    );
  return lines;
}

function comparisonSection(c: DiagnoseComparison) {
  const scope = `${c.mode}/${c.symbols.join("+")}`;
  const lines: string[] = [];
  if (c.family) lines.push(`## 同族历史留出 · ${c.family} · ${scope}`, "");
  if (c.unavailable) lines.push(...c.unavailable, "");
  if (c.familyHoldout) {
    const r = c.familyHoldout,
      s = r.statistics;
    lines.push(
      r.disclosure,
      "",
      s.pboBasis,
      "",
      `切点 ${r.holdoutStart}，开发段滚动 OOS ${s.devOosDays} 日，CSCV 组合数 ${s.combinations}。${r.holdoutRange ? `留出期 ${r.holdoutRange.start} 至 ${r.holdoutRange.end}。` : ""}`,
      "",
      markdownTable(
        ["PBO(Sharpe)", "N_eff", "DSR 候选", "DSR", "DSR 门槛"],
        [
          [
            metric(s.pbo),
            s.effectiveTrials,
            s.dsrCandidateId,
            metric(s.dsr),
            s.dsrThreshold,
          ],
        ],
      ),
      "",
      ...r.candidates.flatMap((c) =>
        c.holdoutFailure ? [`${c.id} 留出段不可用：${c.holdoutFailure}`] : [],
      ),
      `聚类成员：${s.clusters.map((g) => g.join(" + ")).join("；") || "无"}`,
      `排除原因：${s.excluded.map((e) => e.id + " · " + e.reason).join("；") || "无"}`,
      ...[s.pboReason, s.dsrReason].filter((v): v is string => !!v),
      "",
      markdownTable(
        [
          "候选",
          "DSR",
          "留出情景",
          "收益",
          "超额收益",
          "最大回撤",
          "夏普",
          "Calmar",
          "基准 Calmar",
          "Calmar 差值",
          "交易数",
          "费用（元）",
        ],
        r.candidates.flatMap((candidate) =>
          Object.entries(candidate.holdout).map(([leg, m]) => [
            candidate.id,
            metric(candidate.dsr),
            leg,
            percent(m.return),
            percent(m.excess),
            percent(m.drawdown),
            metric(m.sharpe),
            metric(m.calmar),
            metric(m.benchmarkCalmar),
            metric(m.calmarDifference),
            m.trades ?? "—",
            metric(m.fees),
          ]),
        ),
      ),
      "",
    );
  }
  if (c.chanZdImpact) {
    const z = c.chanZdImpact;
    lines.push(
      `## CH14 vs CH14+ZD · ${scope}`,
      "",
      `初始 ZD 无效拒单 ${z.initialZdInvalidRejections.length} 笔，共同入场提前止损 ${z.sharedEntryEarlyStops.length} 轮，提前止损净损益差额 ${z.sharedEntryEarlyStopNetPnlDelta.toFixed(2)} 元。`,
      "",
    );
    if (z.initialZdInvalidRejections.length)
      lines.push(
        markdownTable(
          ["标的", "信号日", "拒单日", "基线入场", "基线净损益"],
          z.initialZdInvalidRejections.map((r) => [
            r.symbol,
            r.signalAt,
            r.date ?? "—",
            r.baselineEntryDate ?? "—",
            metric(r.baselineNetPnl),
          ]),
        ),
        "",
      );
    if (z.sharedEntryEarlyStops.length)
      lines.push(
        markdownTable(
          ["标的", "入场日", "基线退出", "ZD 退出", "净损益差额"],
          z.sharedEntryEarlyStops.map((r) => [
            r.symbol,
            r.entryDate,
            r.baseExitDate,
            r.zdExitDate,
            metric(r.netPnlDelta),
          ]),
        ),
        "",
      );
  }
  return lines;
}

export function renderReport(
  cells: readonly DiagnoseCell[],
  pool?: UniversePoolDisclosure,
  comparisons: readonly DiagnoseComparison[] = [],
): string {
  const perSymbol = cells.filter((cell) => cell.mode === "per-symbol");
  const portfolio = cells.filter((cell) => cell.mode === "portfolio");
  const counts = {
    ok: cells.filter((cell) => cell.status === "ok").length,
    blocked: cells.filter((cell) => cell.status === "blocked").length,
    failed: cells.filter((cell) => cell.status === "failed").length,
  };
  const native = nativeSection(cells);
  const growthPit = growthPitSection(cells);
  const wyckoff = wyckoffSection(cells);
  return [
    "# 回测诊断报告",
    "",
    "> 流程诊断，不是策略业绩；不做收益排名，不构成任何可交易结论。",
    "",
    `- 单元：${cells.length}（ok ${counts.ok} / blocked ${counts.blocked} / failed ${counts.failed}）`,
    `- 单标的：${perSymbol.length}；组合：${portfolio.length}`,
    "",
    ...(pool ? [poolSection(pool), ""] : []),
    "## 单标的",
    "",
    perSymbol.length ? table(perSymbol) : "（无）",
    "",
    "## 组合",
    "",
    portfolio.length ? table(portfolio) : "（无）",
    "",
    ...portfolio.flatMap((cell) => {
      const delayed = cell.portfolioEligibility?.filter(
        (row) => !row.readyDate || (cell.start && row.readyDate > cell.start),
      );
      return delayed?.length
        ? [
            `### 分标的预热 · ${cellLabel(cell)}`,
            "",
            markdownTable(
              ["策略", "标的", "首根行情", "预热根数", "首次可参与日"],
              delayed.map((row) => [
                row.strategyId,
                row.symbol,
                row.firstBar ?? "—",
                row.warmupBars,
                row.readyDate ?? "本期预热不足",
              ]),
            ),
            "",
          ]
        : [];
    }),
    ...(native ? [native, ""] : []),
    ...(growthPit ? [growthPit, ""] : []),
    ...(wyckoff ? [wyckoff, ""] : []),
    ...cells.flatMap(suspensionSection),
    ...comparisons.flatMap(comparisonSection),
    ...cells.flatMap(attributionSection),
    ...cells.flatMap(holdoutSection),
    "## 问题分级",
    "",
    issueSection(cells),
    "",
  ].join("\n");
}

export async function writeReport(
  outDir: string,
  cells: readonly DiagnoseCell[],
  pool?: UniversePoolDisclosure,
  comparisons: readonly DiagnoseComparison[] = [],
): Promise<string> {
  const path = join(outDir, "report.md");
  await writeFile(
    join(outDir, "report.json"),
    JSON.stringify({ pool, cells, comparisons }, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(path, renderReport(cells, pool, comparisons), {
    encoding: "utf8",
    flag: "wx",
  });
  return path;
}

import { ArrowUpRight, Play, SlidersHorizontal, Sparkles } from "lucide-react";
import { screenSortLabels, type ScreenSort } from "~/lib/screen-sort";
import { archivedNameHint, securityDisplayName } from "~/lib/security-display";
import { OnlineScreen } from "../online-screen";
import { ScreenTaskProgress } from "../screen-task-progress";
import { Button } from "../ui/button";

import { ReportCard } from "./reports";
import { Empty, Field, fmt, ResultPager } from "./shared";
import { StrategyFields } from "./strategy-fields";
import { type WorkbenchState } from "./use-workbench-state";

export function ScreenView({
  state,
}: {
  state: Pick<
    WorkbenchState,
    | "setTab"
    | "setSymbol"
    | "period"
    | "setPeriod"
    | "setLoaded"
    | "strategy"
    | "setStrategy"
    | "onlineQuery"
    | "setOnlineQuery"
    | "prompt"
    | "setPrompt"
    | "universe"
    | "setUniverse"
    | "historicalDate"
    | "setHistoricalDate"
    | "universeSource"
    | "setUniverseSource"
    | "requireCurrent"
    | "setRequireCurrent"
    | "screenPage"
    | "setScreenPage"
    | "excludedPage"
    | "setExcludedPage"
    | "errorPage"
    | "setErrorPage"
    | "screenQuery"
    | "setScreenQuery"
    | "screenReportId"
    | "setScreenReportId"
    | "screenSort"
    | "setScreenSort"
    | "screenDirection"
    | "setScreenDirection"
    | "names"
    | "utils"
    | "jobs"
    | "notify"
    | "screen"
    | "interpret"
    | "screenJob"
    | "firstScreenPage"
    | "screened"
    | "exportingScreen"
    | "exportScreen"
    | "screenResult"
    | "reviews"
    | "screenReport"
    | "draft"
    | "symbols"
  >;
}) {
  const {
    setTab,
    setSymbol,
    period,
    setPeriod,
    setLoaded,
    strategy,
    setStrategy,
    onlineQuery,
    setOnlineQuery,
    prompt,
    setPrompt,
    universe,
    setUniverse,
    historicalDate,
    setHistoricalDate,
    universeSource,
    setUniverseSource,
    requireCurrent,
    setRequireCurrent,
    screenPage,
    setScreenPage,
    excludedPage,
    setExcludedPage,
    errorPage,
    setErrorPage,
    screenQuery,
    setScreenQuery,
    screenReportId,
    setScreenReportId,
    screenSort,
    setScreenSort,
    screenDirection,
    setScreenDirection,
    names,
    utils,
    jobs,
    notify,
    screen,
    interpret,
    screenJob,
    firstScreenPage,
    screened,
    exportingScreen,
    exportScreen,
    screenResult,
    reviews,
    screenReport,
    draft,
    symbols,
  } = state;
  return (
    <>
      <OnlineScreen
        jobs={jobs.data ?? []}
        query={onlineQuery}
        setQuery={setOnlineQuery}
        onImport={(selected) => {
          setUniverse(selected.join(","));
          notify(
            `已将本页 ${selected.length} 只证券填入本地池，请核对周期与规则后运行复核`,
          );
        }}
      />
      <section className="panel">
        <div className="panel-title">
          <Sparkles size={17} />
          <h3>本地条件草案（双均线）</h3>
        </div>
        <div className="inline-form">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="自然语言选股条件"
          />
          <Button
            onClick={() => interpret.mutate(prompt)}
            disabled={interpret.isPending}
          >
            <Sparkles size={15} />
            生成条件草案
          </Button>
        </div>
        {draft && (
          <div className="notice">
            <p>{draft.explanation}</p>
            {draft.unsupported.length > 0 && (
              <div>
                <p>本地不支持：{draft.unsupported.join("、")}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOnlineQuery(prompt);
                    document
                      .getElementById("online-screener")
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  将原需求填入在线筛选
                </Button>
              </div>
            )}
            <Button
              size="sm"
              disabled={draft.unsupported.length > 0}
              onClick={() => {
                setStrategy(draft.strategy);
                notify("草案已应用，请核对后运行");
              }}
            >
              确认并应用草案
            </Button>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <SlidersHorizontal size={17} />
          <h3>本地可复现条件</h3>
          <span className="tag">双均线趋势</span>
        </div>
        <StrategyFields strategy={strategy} setStrategy={setStrategy} />
        <label className="muted">
          <input
            type="checkbox"
            checked={requireCurrent}
            disabled={!!historicalDate}
            onChange={(e) => setRequireCurrent(e.target.checked)}
          />
          严格当前模式：时点落后或无法核验时停止，不生成候选分析
        </label>
        <div className="form-grid">
          <Field label="历史研究截止日（留空使用本地最近时点）">
            <input
              type="date"
              value={historicalDate}
              onChange={(e) => {
                setHistoricalDate(e.target.value);
                if (e.target.value) setRequireCurrent(false);
              }}
            />
          </Field>
          {historicalDate && (
            <Field label="历史证券池来源">
              <input
                value={universeSource}
                onChange={(e) => setUniverseSource(e.target.value)}
                placeholder="例如：某日期指数成分股存档；含退市证券的自建名单"
              />
            </Field>
          )}
        </div>
        {historicalDate && (
          <p className="muted">
            历史研究必须填写证券池及来源。按截止日过滤完整历史后计算；分钟历史首次读取可能较慢，可在任务中心取消。当前简称不能证明当时身份，复权及历史事件仍需核验。
          </p>
        )}
        <div className="inline-form">
          <Field label="证券池（留空扫描全部本地 A 股；代码以逗号分隔）">
            <input
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
              placeholder="sh600519,sz000001,sz300750"
            />
          </Field>
          <Button
            onClick={() =>
              screen.mutate({
                strategy,
                period,
                symbols: symbols(),
                asOf: historicalDate || undefined,
                requireCurrent,
                universeSource: historicalDate
                  ? universeSource
                  : undefined,
              })
            }
            disabled={screen.isPending}
          >
            <Play size={15} />
            运行选股
          </Button>
        </div>
        <p className="muted">
          收盘价高于短均线，短均线高于长均线，并满足涨幅与量比条件。采用{" "}
          {period === "day" ? "日线" : "五分钟线"}，按均线差排序。
        </p>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h3>候选结果</h3>
          <Button
            size="sm"
            variant="outline"
            disabled={
              exportingScreen || screenJob?.status !== "completed"
            }
            onClick={exportScreen}
          >
            {exportingScreen ? "导出中…" : "导出本次完整结果"}
          </Button>
          <span className="tag">
            {screenResult?.candidateTotal ?? "—"} 个
          </span>
          <span className="muted">
            {screenResult
              ? `已检查 ${screenResult.total} 个 · ${screenResult.errorTotal} 个读取异常 · ${screenResult.excludedTotal} 个已隔离`
              : screenJob?.status === "completed"
                ? "任务已完成，候选结果尚未读取"
                : "运行后显示真实结果"}
          </span>
        </div>
        {screenJob?.id && <ScreenTaskProgress id={screenJob.id} />}
        {!firstScreenPage && screened.isError && (
          <div role="alert" className="notice">
            <p>
              候选结果读取失败：{screened.error.message}
              。原选股任务和数据已保留，无需重新选股。
            </p>
            <Button
              disabled={screened.isFetching}
              onClick={() => void screened.refetch()}
            >
              重试读取候选
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setScreenSort("original");
                setScreenQuery("");
                setScreenPage(0);
                setExcludedPage(0);
                setErrorPage(0);
              }}
            >
              恢复默认候选视图
            </Button>
          </div>
        )}
        {!firstScreenPage && screened.isFetching && !screenResult && (
          <p role="status">正在读取候选结果…</p>
        )}
        {screenResult ? (
          <>
            <p className="muted">
              选股基准日：
              {screenResult.asOf ?? "旧任务未记录统一基准日"} ·{" "}
              {screenResult.elapsedMs !== undefined
                ? `本地计算 ${(screenResult.elapsedMs / 1000).toFixed(2)} 秒`
                : "旧版结果"}
              。本地数据可能落后于今天；AI 研究在独立后台任务中执行。
            </p>
            {screenResult.dataHealth && (
              <div className="notice">
                <strong>
                  数据时效：
                  {screenResult.dataHealth.status === "aligned"
                    ? "与已知交易时点对齐"
                    : screenResult.dataHealth.status === "lagging"
                      ? "行情已落后"
                      : "当前时效未核验"}
                </strong>
                <p>
                  参考时点：
                  {screenResult.dataHealth.referenceAsOf ??
                    "未知"} · {screenResult.dataHealth.referenceSource}
                </p>
                <p>{screenResult.dataHealth.warnings.join("；")}</p>
              </div>
            )}
            {screenResult.poolContext && (
              <details>
                <summary>
                  本次证券池分布：有效{" "}
                  {screenResult.poolContext.observed}/
                  {screenResult.poolContext.requested}，上涨{" "}
                  {screenResult.poolContext.up}、下跌{" "}
                  {screenResult.poolContext.down}、持平{" "}
                  {screenResult.poolContext.flat}
                </summary>
                <p>
                  高于 {screenResult.poolContext.fastBars} 根均线：
                  {screenResult.poolContext.aboveFast}；高于{" "}
                  {screenResult.poolContext.slowBars} 根均线：
                  {screenResult.poolContext.aboveSlow}。相邻 K
                  线涨跌中位数：
                  {screenResult.poolContext.medianChange === null
                    ? "未知"
                    : `${fmt(screenResult.poolContext.medianChange)}%`}
                  。
                </p>
                <p>{screenResult.poolContext.warnings.join("；")}</p>
              </details>
            )}
            {screenResult.researchMode === "historical" && (
              <p className="notice">
                历史研究截止日：{screenResult.requestedAsOf}
                ；证券池来源：{screenResult.universeSource}。
                {screenResult.researchWarnings.join("；")}
              </p>
            )}
            {screenResult.researchMode === "current" && (
              <p className="notice">
                严格当前模式：本次行情已对齐已知参考时点。个股交易状态和缺失区间仍需核验。
              </p>
            )}
            <div className="inline-form">
              <input
                aria-label="筛选候选名称或代码"
                placeholder="搜索候选名称或代码"
                value={screenQuery}
                onChange={(e) => {
                  setScreenQuery(e.target.value);
                  setScreenPage(0);
                }}
              />
              <select
                aria-label="候选排序字段"
                value={screenSort}
                onChange={(e) => {
                  setScreenSort(e.target.value as ScreenSort);
                  setScreenPage(0);
                }}
              >
                {Object.entries(screenSortLabels).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
              <select
                aria-label="候选排序方向"
                value={screenDirection}
                disabled={screenSort === "original"}
                onChange={(e) => {
                  setScreenDirection(e.target.value as "asc" | "desc");
                  setScreenPage(0);
                }}
              >
                <option value="desc">从高到低</option>
                <option value="asc">从低到高</option>
              </select>
              <Button
                variant="outline"
                disabled={screenPage === 0 || screened.isFetching}
                onClick={() => setScreenPage(screenPage - 1)}
              >
                上一页
              </Button>
              <span>
                第 {screenPage + 1} /{" "}
                {Math.max(1, Math.ceil(screenResult.count / 50))} 页 ·{" "}
                {screenResult.count} 条
              </span>
              <Button
                variant="outline"
                disabled={
                  (screenPage + 1) * 50 >= screenResult.count ||
                  screened.isFetching
                }
                onClick={() => setScreenPage(screenPage + 1)}
              >
                下一页
              </Button>
            </div>
            {screened.isFetching && !firstScreenPage && (
              <p role="status">
                {screened.isPlaceholderData
                  ? "正在更新查询，表格暂时保留上次结果，请等待更新完成。"
                  : "正在更新候选结果…"}
              </p>
            )}
            <div
              className="table-wrap"
              aria-busy={!firstScreenPage && screened.isFetching}
            >
              <table>
                <thead>
                  <tr>
                    <th>证券</th>
                    <th>数据时间</th>
                    <th>收盘</th>
                    <th>涨跌幅</th>
                    <th>量比</th>
                    <th>趋势分</th>
                    <th>AI 快评</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {screenResult.candidates.map((c) => (
                    <tr key={c.symbol}>
                      <td>
                        <strong
                          title={archivedNameHint(
                            c.symbol,
                            names,
                            c.name,
                          )}
                        >
                          {securityDisplayName(c.symbol, names, c.name)}
                        </strong>
                        <small>{c.symbol}</small>
                      </td>
                      <td>{c.metrics.date}</td>
                      <td>{fmt(c.metrics.close)}</td>
                      <td
                        className={
                          c.metrics.change >= 0 ? "up" : "down"
                        }
                      >
                        {fmt(c.metrics.change)}%
                      </td>
                      <td>{fmt(c.metrics.volumeRatio)}</td>
                      <td>{fmt(c.metrics.score)}</td>
                      <td>
                        {(() => {
                          const review = reviews.data?.items.find(
                            (r) => r.snapshotId === c.snapshotId,
                          );
                          return review ? (
                            <div>
                              <p>{review.summary}</p>
                              <span className="tag">
                                风险 {review.riskCount} 项 · 缺口{" "}
                                {review.missingCount} 项
                              </span>
                              {review.risks.map((risk, i) => (
                                <p key={i}>{risk}</p>
                              ))}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setScreenReportId(review.reportId)
                                }
                              >
                                查看完整快评
                              </Button>
                            </div>
                          ) : (
                            <span className="muted">
                              {reviews.isFetching
                                ? "正在读取快评…"
                                : "暂无本任务快评"}
                            </span>
                          );
                        })()}
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            !firstScreenPage &&
                            (screened.isPlaceholderData ||
                              screened.isError)
                          }
                          onClick={async () => {
                            try {
                              const source =
                                await utils.savedSnapshot.fetch(
                                  c.snapshotId,
                                );
                              setTab("market");
                              setSymbol(c.symbol);
                              setPeriod(source.period);
                              setLoaded(source);
                            } catch (error) {
                              notify(
                                error instanceof Error
                                  ? error.message
                                  : "读取快照失败",
                              );
                            }
                          }}
                        >
                          研究 <ArrowUpRight size={13} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {reviews.error && (
              <p role="alert">
                快评读取失败：{reviews.error.message}
                <Button onClick={() => void reviews.refetch()}>
                  重试快评
                </Button>
              </p>
            )}
            {screenReportId && (
              <section>
                <Button
                  variant="outline"
                  onClick={() => setScreenReportId("")}
                >
                  收起完整快评
                </Button>
                {screenReport.isLoading && (
                  <p role="status">正在读取完整快评…</p>
                )}
                {screenReport.error && (
                  <p role="alert">
                    {screenReport.error.message}
                    <Button onClick={() => void screenReport.refetch()}>
                      重试报告
                    </Button>
                  </p>
                )}
                {screenReport.data && (
                  <ReportCard
                    report={screenReport.data}
                    securityContext={screenReport.data.securityContext}
                    names={names}
                  />
                )}
              </section>
            )}
            {!!screenResult.excludedTotal && (
              <details>
                <summary>
                  查看隔离原因（{screenResult.excludedTotal}）
                </summary>
                <ResultPager
                  page={excludedPage}
                  count={screenResult.excludedTotal}
                  onChange={setExcludedPage}
                />
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>证券</th>
                        <th>数据时间</th>
                        <th>原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {screenResult.excluded.map((item) => (
                        <tr key={item.symbol}>
                          <td>
                            <span
                              title={archivedNameHint(
                                item.symbol,
                                names,
                                item.name,
                              )}
                            >
                              {securityDisplayName(
                                item.symbol,
                                names,
                                item.name,
                              )}
                            </span>
                            <small>{item.symbol}</small>
                          </td>
                          <td>{item.date ?? "—"}</td>
                          <td>{item.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
            {screenResult.errorTotal > 0 && (
              <details>
                <summary>
                  读取异常明细（{screenResult.errorTotal}）
                </summary>
                <ResultPager
                  page={errorPage}
                  count={screenResult.errorTotal}
                  onChange={setErrorPage}
                />
                <pre>
                  {JSON.stringify(screenResult.errors, null, 2)}
                </pre>
              </details>
            )}
          </>
        ) : (
          screenJob?.status !== "completed" && (
            <Empty>
              运行规则筛选，结果会附带数据时间；前 10 个候选默认自动进行
              AI 分析。
            </Empty>
          )
        )}
      </section>
    </>
  );
}

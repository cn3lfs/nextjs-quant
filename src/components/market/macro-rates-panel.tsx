"use client";
import { Bank } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { Panel, PanelEmpty } from "../panels";
import { Button } from "../ui/button";
import { usePanelVisible } from "../workbench/keep-alive";

const pct = (value: number | null | undefined, digits = 3) =>
  value == null ? "—" : value.toFixed(digits) + "%";
const bp = (value: number | null) =>
  value == null
    ? "—"
    : (value > 0 ? "+" : "") + Math.round(value * 100) + " BP";
const diff = (a?: number | null, b?: number | null) =>
  a == null || b == null ? null : a - b;

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <span className="shrink-0 text-[13px] text-nc-text-3">{label}</span>
      <span className="text-right text-sm font-medium tabular-nums">
        {value}
        {note && (
          <small className="mt-1 block text-[13px] font-normal text-nc-text-3">
            {note}
          </small>
        )}
      </span>
    </div>
  );
}

/** Source dates stay separate from the futures chart and the query cache age. */
export function MacroRatesPanel() {
  const visible = usePanelVisible();
  const query = api.macroRates.useQuery(undefined, {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60 * 60000,
  });
  const data = query.data;
  const treasury = data?.treasury ?? [];
  const latestTreasury = treasury.at(-1);
  const priorTreasury = treasury.at(-21);
  const repo = data?.repo ?? [];
  const latestRepo = repo.at(-1);
  const recentRepo = repo.slice(-20);
  const averageFr007 = recentRepo.length
    ? recentRepo.reduce((sum, value) => sum + value.fr007, 0) /
      recentRepo.length
    : null;
  const latestLpr = data?.lpr.at(-1);
  return (
    <Panel icon={Bank} title="宏观利率" meta="独立缓存1小时，源日期分别显示">
      {query.error && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 text-nc-bad"
        >
          宏观利率读取失败：{query.error.message}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            重试宏观数据
          </Button>
        </div>
      )}
      {!data && !query.error && <PanelEmpty>正在读取宏观利率…</PanelEmpty>}
      {data && (
        <div aria-busy={query.isFetching}>
          {query.error && (
            <p className="mb-3 text-[13px] text-nc-warn">
              下方保留上次读取结果，请按各来源日期判断。
            </p>
          )}
          <div className="nc-macro-groups">
            <section className="nc-macro-group">
              <h4>中国国债收益率</h4>
              <p className="text-[13px] text-nc-text-3">
                中债国债曲线 · {latestTreasury?.date ?? "日期未取得"}
              </p>
              <Row
                label="1年"
                value={pct(latestTreasury?.["1y"])}
                note={
                  "较20条记录前 " +
                  bp(diff(latestTreasury?.["1y"], priorTreasury?.["1y"]))
                }
              />
              <Row
                label="10年"
                value={pct(latestTreasury?.["10y"])}
                note={
                  "较20条记录前 " +
                  bp(diff(latestTreasury?.["10y"], priorTreasury?.["10y"]))
                }
              />
              <Row
                label="30年"
                value={pct(latestTreasury?.["30y"])}
                note={
                  "较20条记录前 " +
                  bp(diff(latestTreasury?.["30y"], priorTreasury?.["30y"]))
                }
              />
              <Row
                label="10Y−1Y利差"
                value={bp(
                  diff(latestTreasury?.["10y"], latestTreasury?.["1y"]),
                )}
              />
              <p className="text-[13px] text-nc-text-3">
                比较源记录，不保证连续20个交易日；记录不足留空。
              </p>
            </section>
            <section className="nc-macro-group">
              <h4>回购定盘利率</h4>
              <p className="text-[13px] text-nc-text-3">
                中国货币网 · {latestRepo?.date ?? "日期未取得"}
              </p>
              <Row label="FR007" value={pct(latestRepo?.fr007, 2)} />
              <Row label="FR001" value={pct(latestRepo?.fr001, 2)} />
              <Row
                label={"最近" + recentRepo.length + "条FR007均值"}
                value={pct(averageFr007, 2)}
              />
              <p className="text-[13px] text-nc-text-3">
                最多取20条可读记录，不将条数冒充交易日数。
              </p>
            </section>
            <section className="nc-macro-group">
              <h4>贷款市场报价利率</h4>
              <p className="text-[13px] text-nc-text-3">
                东方财富 · 发布月份 {latestLpr?.date.slice(0, 7) ?? "未取得"}
              </p>
              <Row label="LPR 1年" value={pct(latestLpr?.lpr1y, 2)} />
              <Row label="LPR 5年" value={pct(latestLpr?.lpr5y, 2)} />
            </section>
          </div>
          {data.failures.length > 0 && (
            <p role="status" className="mt-3 text-[13px] text-nc-warn">
              部分来源未能读取：
              {data.failures
                .map((item) => item.part + "（" + item.message + "）")
                .join("；")}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

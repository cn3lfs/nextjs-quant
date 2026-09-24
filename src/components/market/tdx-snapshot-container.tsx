"use client";
import { api } from "~/trpc/react";
import { isMarketIndex } from "~/lib/market/market-indices";
import { isCryptoChartSymbol } from "~/lib/chart/chart-symbol";
import { TdxFundamentalSummary } from "./tdx-fundamental-summary";
import { TdxCompanyInfo } from "./tdx-company-info";
import {
  financeQueryOptions,
  quoteQueryOptions,
  tradableSymbol,
} from "./tdx-side-panel";
import { Button } from "../ui/button";

/**
 * 图表下方的基本面详情。五档盘口与关键指标在右栏 TdxSidePanel，这里与它共用
 * 查询缓存，只展开右栏放不下的完整口径、报表明细与 F10 公司资料。
 */
export function TdxSnapshotContainer({ symbol }: { symbol: string }) {
  const quotable = tradableSymbol(symbol);
  const index = isMarketIndex(symbol);
  const quotes = api.tdxQuotes.useQuery([symbol], {
    ...quoteQueryOptions,
    enabled: quotable,
  });
  const local = api.tdxLocalFinancials.useQuery(symbol, {
    ...financeQueryOptions,
    enabled: quotable && !index,
  });
  const finance = api.tdxFinance.useQuery(symbol, {
    ...financeQueryOptions,
    enabled: quotable && !index,
  });
  if (!quotable)
    return isCryptoChartSymbol(symbol) ? null : (
      <p className="text-sm text-muted-foreground">
        板块与自定义指数没有通达信实时盘口与财务快照，本区块不适用。
      </p>
    );
  if (index) return null;
  const quote = quotes.data?.[0];
  return (
    <section
      aria-label="基本面详情"
      className="space-y-2 border-t border-nc-border-soft pt-3"
    >
      <h3 className="m-0 text-[13px] font-medium">
        基本面详情
        <span className="ml-2 text-[11px] font-normal text-nc-text-4">
          完整指标、报表明细与公司资料
        </span>
      </h3>
      {local.error && (
        <div role="alert" className="text-sm">
          本地财务包读取失败：{local.error.message}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void local.refetch()}
          >
            重试本地财务
          </Button>
        </div>
      )}
      {local.data && !local.data.financials && (
        <p role="status" className="text-sm">
          本地没有该证券的财务数据：{local.data.reason}
        </p>
      )}
      {!local.error && !local.data && (
        <p role="status" className="text-sm">
          正在读取本地财务包…
        </p>
      )}
      {local.data?.financials && (
        <TdxFundamentalSummary
          report={local.data.financials.fields}
          reportDate={local.data.financials.reportDate}
          sourceFilename={local.data.financials.sourceFilename}
          overlay={finance.data?.finance ?? null}
          overlayPending={finance.isFetching && !finance.data}
          overlayError={finance.error?.message ?? null}
          lag={finance.data?.lag ?? null}
          price={
            quote && Number.isFinite(quote.price) && quote.price > 0
              ? quote.price
              : null
          }
        >
          <TdxCompanyInfo symbol={symbol} />
        </TdxFundamentalSummary>
      )}
    </section>
  );
}

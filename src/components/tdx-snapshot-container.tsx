"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "~/trpc/react";
import { isMarketIndex } from "~/lib/market-indices";
import { chartPricePrecision, isSectorChartSymbol } from "~/lib/chart-symbol";
import {
  quoteRefreshInterval,
  quoteSession,
  quoteSessionLabels,
  type QuoteSession,
} from "~/lib/tdx-quote-view";
import { TdxQuoteBook } from "./tdx-quote-book";
import { TdxFundamentalSummary } from "./tdx-fundamental-summary";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const tradableSymbol = (symbol: string) => /^(sh|sz|bj)\d{6}$/.test(symbol);

/** 时段只驱动刷新节奏，所以在客户端定时重算即可，不在服务端渲染时判定。 */
function useQuoteSession() {
  const [session, setSession] = useState<QuoteSession | null>(null);
  useEffect(() => {
    const update = () => setSession(quoteSession(Date.now()));
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);
  return session;
}

export function TdxSnapshotContainer({ symbol }: { symbol: string }) {
  const [auto, setAuto] = useState(false);
  const session = useQuoteSession();
  const quotable = tradableSymbol(symbol) && !isSectorChartSymbol(symbol);
  const index = isMarketIndex(symbol);
  const interval = session === null ? null : quoteRefreshInterval(session);
  const quotes = api.tdxQuotes.useQuery([symbol], {
    enabled: quotable,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: auto && interval !== null ? interval : false,
  });
  const finance = api.tdxFinance.useQuery(symbol, {
    enabled: quotable && !index,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 3600000,
  });
  const quote = quotes.data?.[0];
  if (!quotable)
    return (
      <p className="text-sm text-muted-foreground">
        板块与自定义指数没有通达信实时盘口与财务快照，本区块不适用。
      </p>
    );
  return (
    <section aria-label="实时盘口与基本面" className="space-y-3">
      <Tabs defaultValue="quote">
        <div className="flex flex-wrap items-center gap-3">
          <TabsList>
            <TabsTrigger value="quote">五档盘口</TabsTrigger>
            <TabsTrigger value="fundamental" disabled={index}>
              基本面快照
            </TabsTrigger>
          </TabsList>
          <Button
            size="sm"
            variant="outline"
            disabled={quotes.isFetching}
            onClick={() => {
              void quotes.refetch();
              void finance.refetch();
            }}
          >
            <RefreshCw size={13} />
            刷新快照
          </Button>
          <Label htmlFor="tdx-quote-auto">
            <Switch
              id="tdx-quote-auto"
              checked={auto}
              onCheckedChange={setAuto}
            />
            自动刷新
          </Label>
          <span role="status" className="text-xs text-muted-foreground">
            {session === null
              ? "正在判定交易时段…"
              : interval === null
                ? `${quoteSessionLabels[session]} · 不自动刷新，可手动刷新`
                : auto
                  ? `${quoteSessionLabels[session]} · 每 ${interval / 1000} 秒刷新`
                  : `${quoteSessionLabels[session]} · 自动刷新已关闭`}
            {session !== null &&
              " · 时段按北京时间星期与钟点判定，不含节假日日历"}
          </span>
        </div>
        <TabsContent value="quote" className="space-y-2">
          {quotes.error && (
            <div role="alert" className="text-sm">
              盘口读取失败：{quotes.error.message}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void quotes.refetch()}
              >
                重试盘口
              </Button>
            </div>
          )}
          {!quotes.error && !quote && (
            <p role="status" className="text-sm">
              {quotes.isFetching ? "正在读取五档盘口…" : "尚无盘口快照"}
            </p>
          )}
          {quote && (
            <TdxQuoteBook
              quote={quote}
              precision={chartPricePrecision(symbol)}
              session={session ?? "post"}
              hasOrderBook={quote.bids.length > 0 || quote.asks.length > 0}
            />
          )}
        </TabsContent>
        <TabsContent value="fundamental" className="space-y-2">
          {finance.error && (
            <div role="alert" className="text-sm">
              财务快照读取失败：{finance.error.message}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void finance.refetch()}
              >
                重试财务快照
              </Button>
            </div>
          )}
          {!finance.error && !finance.data && (
            <p role="status" className="text-sm">
              {finance.isFetching ? "正在读取财务快照…" : "尚无财务快照"}
            </p>
          )}
          {finance.data && (
            <TdxFundamentalSummary
              finance={finance.data.finance}
              period={finance.data.period.period}
              periodReason={finance.data.period.reason}
              price={
                quote && Number.isFinite(quote.price) && quote.price > 0
                  ? quote.price
                  : null
              }
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

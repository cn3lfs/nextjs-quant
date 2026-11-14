import { Suspense } from "react";
import { StockPoolView } from "~/components/market/stock-pool-view";

export default function StockPoolPage() {
  return (
    <Suspense fallback={<p role="status">正在读取证券池…</p>}>
      <StockPoolView />
    </Suspense>
  );
}

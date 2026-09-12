import { TradeReviewContainer } from "~/components/trade-review-container";

export default function TradeReviewPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">交割单与交易复盘</h1>
      <TradeReviewContainer />
    </main>
  );
}

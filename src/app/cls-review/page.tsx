import { ClsReviewControls } from "~/components/cls-review-controls";
export default function ClsReviewPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">财联社观点复盘</h1>
      <ClsReviewControls />
    </main>
  );
}

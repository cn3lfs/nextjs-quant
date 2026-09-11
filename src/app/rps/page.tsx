import { RpsControls } from "~/components/rps-controls";
import { IndustryRpsControls } from "~/components/industry-rps-controls";
import { ConceptRpsControls } from "~/components/concept-rps-controls";

export default function RpsPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">个股RPS数据管理</h1>
      <a className="text-primary underline" href="/intraday">
        午尾盘预选与收盘确认
      </a>
      <a className="ml-4 text-primary underline" href="/research">
        策略样本研究
      </a>
      <RpsControls />
      <a className="text-primary underline" href="/cls-review">
        财联社观点复盘
      </a>
      <IndustryRpsControls />
      <ConceptRpsControls />
    </main>
  );
}

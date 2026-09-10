import { RpsControls } from "~/components/rps-controls";
import { IndustryRpsControls } from "~/components/industry-rps-controls";

export default function RpsPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <a href="/">返回工作台</a>
      <h1 className="text-2xl font-semibold">个股RPS数据管理</h1>
      <RpsControls />
      <IndustryRpsControls />
    </main>
  );
}

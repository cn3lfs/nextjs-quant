import { IntradayControls } from "~/components/intraday-controls";

export default function IntradayPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">午尾盘预选与收盘确认</h1>
      <IntradayControls />
    </main>
  );
}

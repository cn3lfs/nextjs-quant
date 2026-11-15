"use client";

import { Button } from "~/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="page">
      <p role="alert">本地账本读取失败，请检查本地数据后重试。</p>
      <Button variant="plain" onClick={reset}>
        重试
      </Button>
      <a href="/">返回工作台</a>
    </main>
  );
}

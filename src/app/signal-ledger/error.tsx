"use client";

import { Button } from "~/components/ui/button";
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <main className="page">
      <p role="alert">信号台账读取失败。</p>
      <Button variant="plain" onClick={retry}>
        重新读取
      </Button>{" "}
      <a href="/">返回工作台</a>
    </main>
  );
}

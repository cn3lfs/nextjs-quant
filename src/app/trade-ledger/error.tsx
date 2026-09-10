"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="page">
      <p role="alert">本地账本读取失败，请检查本地数据后重试。</p>
      <button onClick={reset}>重试</button>
      <a href="/">返回工作台</a>
    </main>
  );
}

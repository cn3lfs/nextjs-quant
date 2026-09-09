"use client";
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <main className="page">
      <p role="alert">信号台账读取失败。</p>
      <button onClick={retry}>重新读取</button> <a href="/">返回工作台</a>
    </main>
  );
}

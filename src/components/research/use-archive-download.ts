"use client";
import { useState } from "react";

export function useArchiveDownload() {
  const [error, setError] = useState("");
  function save(content: () => string, name: string, type: string) {
    setError("");
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([content()], { type }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
    } catch {
      setError("导出未成功，请重试导出；原始报告未被修改。");
    } finally {
      if (url) {
        const value = url;
        setTimeout(() => URL.revokeObjectURL(value), 1000);
      }
    }
  }
  return { save, error };
}

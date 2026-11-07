export function downloadFinancialJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.json`;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

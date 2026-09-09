export function validateHithinkColumns(
  row: Record<string, unknown>,
  columns: { key: string; type?: string; timestamp?: string }[],
) {
  const dates = (value: string) => {
    const parts = value.split("-");
    if (
      parts.length > 2 ||
      parts.some((stamp) => {
        const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
        const time = Date.parse(`${day}T00:00:00Z`);
        return (
          !/^\d{8}$/.test(stamp) ||
          !Number.isFinite(time) ||
          new Date(time).toISOString().slice(0, 10) !== day
        );
      }) ||
      (parts.length === 2 && parts[0]! > parts[1]!)
    )
      throw new Error("问财字段日期非法");
  };
  const keys = new Set<string>();
  for (const column of columns) {
    if (keys.has(column.key)) throw new Error("问财字段重复");
    keys.add(column.key);
    const embedded = column.key.match(/\[(\d{8}(?:-\d{8})?)\]$/)?.[1];
    if (embedded) dates(embedded);
    if (column.timestamp) {
      dates(column.timestamp);
      if (embedded && embedded !== column.timestamp)
        throw new Error("问财字段日期冲突");
    }
    const value = row[column.key];
    if (value == null || value === "--") continue;
    if (column.type === "DATE") {
      if (!/^\d{8}$/.test(String(value))) throw new Error("问财日期值非法");
      dates(String(value));
    }
    if (
      column.type === "DOUBLE" &&
      ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" &&
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
            value.trim(),
          )) ||
        !Number.isFinite(Number(value)))
    )
      throw new Error("问财数值字段非法");
    if (column.type === "STR" && typeof value !== "string")
      throw new Error("问财文本字段非法");
    if (
      column.type === "ARRAY" &&
      (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    )
      throw new Error("问财分类数组非法");
  }
}

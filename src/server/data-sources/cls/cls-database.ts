import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Shared read-only boundary for the news browser and daily analysis workflow. */
export function openClsNewsDatabase(path: string) {
  if (!path.trim())
    throw new Error(
      "尚未配置财联社数据库，请到“数据与连接设置 → 新闻采集”填写路径",
    );
  if (!isAbsolute(path))
    throw new Error("财联社数据库需要绝对路径，请检查新闻采集设置");
  let connection: Database.Database | undefined;
  try {
    if (!statSync(path).isFile())
      throw new Error("财联社数据库路径不是文件，请检查新闻采集设置");
    connection = new Database(path, { readonly: true, fileMustExist: true });
    // Validate the fields used by the existing news reader without scanning news content.
    const columns = new Set(
      (connection.pragma("table_info(news)") as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    const missing = [
      "id",
      "ctime",
      "collected_at",
      "title",
      "content",
      "shareurl",
    ].filter((column) => !columns.has(column));
    if (missing.length)
      throw new Error(
        `财联社数据库格式不符：news 表缺少 ${missing.join("、")}`,
      );
    return connection;
  } catch (error) {
    connection?.close();
    const code = (error as { code?: string }).code;
    if (code === "ENOENT")
      throw new Error("财联社数据库不存在，请检查新闻采集设置中的路径");
    if (code === "EACCES" || code === "EPERM" || code === "SQLITE_CANTOPEN")
      throw new Error(
        "财联社数据库无法只读打开，请检查文件读取权限和新闻采集设置",
      );
    if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT")
      throw new Error("财联社数据库不是有效的 SQLite 新闻存档，请检查文件格式");
    throw error;
  }
}

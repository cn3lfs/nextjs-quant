import {
  newsSourceConfiguration,
  type NewsSourceCheck,
  type NewsSourceSettings,
} from "~/lib/settings/news-source-settings";
import { openClsNewsDatabase } from "../data-sources/cls/cls-database";
import { newsPythonVersion } from "./news-python";

export async function checkNewsSources(
  saved: NewsSourceSettings,
  expected: NewsSourceSettings,
): Promise<NewsSourceCheck> {
  const configuration = newsSourceConfiguration(saved);
  if (
    JSON.stringify(configuration) !==
    JSON.stringify(newsSourceConfiguration(expected))
  )
    throw new Error("新闻配置已变化，请刷新设置后重新检查");
  let database: NewsSourceCheck["database"];
  try {
    const connection = openClsNewsDatabase(configuration.clsDbPath);
    connection.close();
    database = { ok: true, message: "数据库可只读打开，news 表字段可用" };
  } catch (error) {
    database = {
      ok: false,
      message: error instanceof Error ? error.message : "新闻数据库检查失败",
    };
  }
  let python: NewsSourceCheck["python"];
  try {
    python = {
      ok: true,
      message: await newsPythonVersion(configuration.newsPythonExecutable),
    };
  } catch (error) {
    python = {
      ok: false,
      message: error instanceof Error ? error.message : "Python 检查失败",
    };
  }
  return { configuration, checkedAt: Date.now(), database, python };
}

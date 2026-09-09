import { sqlite, dataDirectory } from "../src/server/db";
sqlite();
console.log("数据库迁移完成：", dataDirectory());

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const records = sqliteTable("records", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

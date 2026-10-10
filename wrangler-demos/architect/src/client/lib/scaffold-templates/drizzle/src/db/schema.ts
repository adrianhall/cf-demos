import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Example table — replace with your own schema.
 * After editing, run `npm run db:generate` to create a new migration.
 */
export const examples = sqliteTable("examples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

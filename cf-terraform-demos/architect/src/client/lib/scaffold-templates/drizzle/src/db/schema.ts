import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * An example table — replace it with your own schema.
 *
 * After editing this file run `npm run db:generate` to produce a migration, then `npm run
 * db:migrate:local` to apply it to the local D1 simulation.
 */
export const examples = sqliteTable('examples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
});

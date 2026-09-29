import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

/** Kept separate from db.module.ts so providers can import it without a circular import. */
export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;

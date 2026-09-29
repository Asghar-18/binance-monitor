import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'path';
import { AppConfig, CONFIG } from '../config';
import { KvService } from './kv.service';
import * as schema from './schema';

import { DB } from './tokens';

export { DB, Db } from './tokens';
const POOL = Symbol('POOL');

@Global()
@Module({
  providers: [
    {
      provide: POOL,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) => new Pool({ connectionString: cfg.DATABASE_URL, max: 5 }),
    },
    {
      provide: DB,
      inject: [POOL],
      useFactory: async (pool: Pool) => {
        const db = drizzle(pool, { schema });
        const log = new Logger('Database');
        // Retry while Postgres is still starting.
        for (let attempt = 1; ; attempt++) {
          try {
            // dist/db -> ../../drizzle (compiled) and src/db -> ../../drizzle (dev) both resolve to apps/backend/drizzle
            await migrate(db, { migrationsFolder: join(__dirname, '..', '..', 'drizzle') });
            log.log('Migrations applied');
            return db;
          } catch (e) {
            if (attempt >= 10) throw e;
            log.warn(`Database not ready (attempt ${attempt}): ${(e as Error).message}`);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      },
    },
    KvService,
  ],
  exports: [DB, KvService],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

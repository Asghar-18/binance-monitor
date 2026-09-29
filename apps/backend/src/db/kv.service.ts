import { Inject, Injectable } from '@nestjs/common';
import { eq, like } from 'drizzle-orm';
import { DB, Db } from './tokens';
import { syncState } from './schema';

/** Small key-value store on the sync_state table for settings and flags. */
@Injectable()
export class KvService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(syncState).where(eq(syncState.key, key));
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: new Date() } });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(syncState).where(eq(syncState.key, key));
  }

  async byPrefix(prefix: string): Promise<{ key: string; value: string }[]> {
    return this.db.select({ key: syncState.key, value: syncState.value }).from(syncState).where(like(syncState.key, `${prefix}%`));
  }
}

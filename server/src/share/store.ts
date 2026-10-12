import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Share } from '@noteviewer/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Public read-only share links, persisted as `shares.json` in the data dir.
 * Deliberately kept out of the vault: the vault is git-synced to GitHub and
 * tokens are bearer credentials. Without a data dir the store is in-memory.
 */
export class ShareStore {
  private shares: Share[] = [];

  private constructor(private readonly file: string | undefined) {}

  static async open(dataDir?: string): Promise<ShareStore> {
    const store = new ShareStore(dataDir ? path.join(dataDir, 'shares.json') : undefined);
    if (store.file) {
      await fs.mkdir(dataDir!, { recursive: true });
      try {
        const raw = JSON.parse(await fs.readFile(store.file, 'utf8')) as { shares?: Share[] };
        store.shares = raw.shares ?? [];
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return store;
  }

  private live(s: Share): boolean {
    return s.expiresAt === null || Date.parse(s.expiresAt) > Date.now();
  }

  get(token: string): Share | undefined {
    const s = this.shares.find((x) => x.token === token);
    return s && this.live(s) ? s : undefined;
  }

  list(notePath: string): Share[] {
    return this.shares.filter((s) => s.path === notePath && this.live(s));
  }

  async create(notePath: string, expiresInDays: number | null): Promise<Share> {
    const now = Date.now();
    const share: Share = {
      token: randomBytes(16).toString('base64url'),
      path: notePath,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresInDays ? new Date(now + expiresInDays * DAY_MS).toISOString() : null,
    };
    // expired entries are pruned on every write so the file doesn't grow forever
    this.shares = [...this.shares.filter((s) => this.live(s)), share];
    await this.save();
    return share;
  }

  async revoke(token: string): Promise<boolean> {
    const before = this.shares.length;
    this.shares = this.shares.filter((s) => s.token !== token);
    if (this.shares.length === before) return false;
    await this.save();
    return true;
  }

  async renamePath(from: string, to: string): Promise<void> {
    let changed = false;
    for (const s of this.shares) {
      if (s.path === from) {
        s.path = to;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async removePath(notePath: string): Promise<void> {
    const before = this.shares.length;
    this.shares = this.shares.filter((s) => s.path !== notePath);
    if (this.shares.length !== before) await this.save();
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ shares: this.shares }, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}

type Item = { id: string; text: string };
type Pending = { items: Item[]; resolve: (v: number[][]) => void; reject: (e: unknown) => void };
type Group = { model: string; pending: Pending[]; count: number; timer: NodeJS.Timeout };

/**
 * Coalesces concurrent embed requests that share a key (tenant + model) into one provider call:
 * a group flushes at `maxItems` items or `maxWaitMs` after its first request, whichever is first.
 * Each caller gets back exactly its own vectors, in order. A request never splits across calls
 * (jobs are capped at maxItems), so a request that would overflow flushes the group first.
 * ponytail: in-process only, so coalescing happens per worker process; a cross-process batch would need a Redis-side buffer.
 */
export class EmbedBatcher {
  private groups = new Map<string, Group>();

  constructor(
    private call: (model: string, texts: string[]) => Promise<number[][]>,
    private maxItems = 128,
    private maxWaitMs = 500,
  ) {}

  embed(key: string, model: string, items: Item[]): Promise<number[][]> {
    return new Promise((resolve, reject) => {
      let g = this.groups.get(key);
      if (g && g.count + items.length > this.maxItems) {
        void this.flush(key);
        g = undefined;
      }
      if (!g) {
        g = { model, pending: [], count: 0, timer: setTimeout(() => void this.flush(key), this.maxWaitMs) };
        this.groups.set(key, g);
      }
      g.pending.push({ items, resolve, reject });
      g.count += items.length;
      if (g.count >= this.maxItems) void this.flush(key);
    });
  }

  private async flush(key: string) {
    const g = this.groups.get(key);
    if (!g) return;
    this.groups.delete(key);
    clearTimeout(g.timer);
    try {
      const vectors = await this.call(g.model, g.pending.flatMap((p) => p.items.map((i) => i.text)));
      let offset = 0;
      for (const p of g.pending) {
        p.resolve(vectors.slice(offset, offset + p.items.length));
        offset += p.items.length;
      }
    } catch (err) {
      for (const p of g.pending) p.reject(err); // e.g. a 429: every job in the batch backs off
    }
  }
}

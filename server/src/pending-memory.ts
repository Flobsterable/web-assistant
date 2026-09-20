import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryCandidate, PendingMemorySuggestion } from './memory.js';

type PersistedPending = { version: 1; suggestions: PendingMemorySuggestion[] };

export class JsonPendingMemoryStore {
  private writeQueue = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async list(): Promise<PendingMemorySuggestion[]> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedPending>;
      return Array.isArray(data.suggestions) ? data.suggestions : [];
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      return [];
    }
  }

  async add(sessionId: string, profileId: string, candidate: MemoryCandidate & { scope: 'long-term' }) {
    return this.enqueue(async () => {
      const suggestions = await this.list();
      const suggestion: PendingMemorySuggestion = {
        id: `pending-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
        sessionId,
        profileId,
        candidate,
        createdAt: new Date().toISOString()
      };
      await this.save([...suggestions, suggestion]);
      return suggestion;
    });
  }

  async take(id: string) {
    return this.enqueue(async () => {
      const suggestions = await this.list();
      const suggestion = suggestions.find((item) => item.id === id) ?? null;
      if (suggestion) await this.save(suggestions.filter((item) => item.id !== id));
      return suggestion;
    });
  }

  async clear() {
    await this.enqueue(() => this.save([]));
  }

  private async enqueue<T>(operation: () => Promise<T>) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async save(suggestions: PendingMemorySuggestion[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, suggestions }, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }
}

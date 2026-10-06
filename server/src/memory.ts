import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type MemoryLayer = 'working' | 'long-term';
export type MemoryScope = 'none' | MemoryLayer;
export type MemoryOperation = 'create' | 'update' | 'delete' | 'skip';
export type WorkingMemoryCategory = 'goal' | 'constraint' | 'artifact' | 'note';
export type LongTermMemoryCategory = 'profile' | 'decision' | 'knowledge';
export type MemoryCategory = WorkingMemoryCategory | LongTermMemoryCategory;

export type MemoryEntry = {
  id: string;
  layer: MemoryLayer;
  category: MemoryCategory;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
  source?: 'manual' | 'agent';
};

export type WorkingMemoryEntry = MemoryEntry & {
  layer: 'working';
  category: WorkingMemoryCategory;
};

export type LongTermMemoryEntry = MemoryEntry & {
  layer: 'long-term';
  category: LongTermMemoryCategory;
  profileId: string;
};

export type MemoryCandidate = {
  scope: MemoryScope;
  operation: MemoryOperation;
  category?: MemoryCategory;
  key: string;
  value?: string;
  targetId?: string;
  confidence: number;
  importance?: number;
  reason: string;
};

export type MemoryClassificationResult = {
  candidates: MemoryCandidate[];
  raw?: string;
};

export type PendingMemorySuggestion = {
  id: string;
  sessionId: string;
  profileId: string;
  candidate: MemoryCandidate & { scope: 'long-term' };
  createdAt: string;
};

export type MemoryEventType =
  | 'skipped'
  | 'created'
  | 'updated'
  | 'deleted'
  | 'suggestion_created'
  | 'suggestion_approved'
  | 'suggestion_rejected'
  | 'clarification_required'
  | 'invalid_candidate';

export type MemoryEvent = {
  type: MemoryEventType;
  scope: MemoryScope;
  candidate?: MemoryCandidate;
  entryId?: string;
  suggestionId?: string;
  reason: string;
  createdAt: string;
};

export type MemorySnapshot = {
  working: MemoryEntry[];
  longTerm: MemoryEntry[];
};

export type MemoryWrite = {
  layer: MemoryLayer;
  category: MemoryCategory;
  key: string;
  value: string;
  source?: 'manual' | 'agent';
};

export interface AgentMemoryStore {
  load: () => Promise<MemorySnapshot>;
  upsert: (write: MemoryWrite) => Promise<MemoryEntry>;
  update: (layer: MemoryLayer, id: string, write: MemoryWrite) => Promise<MemoryEntry | null>;
  replaceAgentWorking: (writes: MemoryWrite[]) => Promise<MemoryEntry[]>;
  remove: (layer: MemoryLayer, id: string) => Promise<void>;
  clearWorking: () => Promise<void>;
}

type PersistedMemory = {
  version: 1;
  entries: MemoryEntry[];
};

const categoryByLayer: Record<MemoryLayer, readonly MemoryCategory[]> = {
  working: ['goal', 'constraint', 'artifact', 'note'],
  'long-term': ['profile', 'decision', 'knowledge']
};

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    (entry.layer === 'working' || entry.layer === 'long-term') &&
    typeof entry.category === 'string' &&
    categoryByLayer[entry.layer].includes(entry.category as MemoryCategory) &&
    typeof entry.key === 'string' &&
    typeof entry.value === 'string' &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string'
  );
}

export function validateMemoryWrite(value: unknown): MemoryWrite | string {
  if (!value || typeof value !== 'object') return 'Memory write body is required.';
  const candidate = value as Record<string, unknown>;
  const layer = candidate.layer;
  const category = candidate.category;
  const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
  const memoryValue = typeof candidate.value === 'string' ? candidate.value.trim() : '';

  if (layer !== 'working' && layer !== 'long-term') return 'Memory layer must be working or long-term.';
  if (typeof category !== 'string' || !categoryByLayer[layer].includes(category as MemoryCategory)) {
    return `Category is not valid for ${layer} memory.`;
  }
  if (!key) return 'Memory key is required.';
  if (!memoryValue) return 'Memory value is required.';
  if (key.length > 80) return 'Memory key must be at most 80 characters.';
  if (memoryValue.length > 2000) return 'Memory value must be at most 2000 characters.';

  return { layer, category: category as MemoryCategory, key, value: memoryValue };
}

class JsonEntryFile {
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string, private readonly expectedLayer: MemoryLayer) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedMemory>;
      return Array.isArray(parsed.entries)
        ? parsed.entries.filter((entry) => isMemoryEntry(entry) && entry.layer === this.expectedLayer)
        : [];
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      await this.backupUnreadableFile();
      return [];
    }
  }

  async upsert(write: MemoryWrite) {
    return this.enqueue(async () => {
      const entries = await this.load();
      const now = new Date().toISOString();
      const existing = entries.find((entry) => entry.key.toLowerCase() === write.key.toLowerCase());
      const saved: MemoryEntry = existing
        ? { ...existing, category: write.category, key: write.key, value: write.value, updatedAt: now }
        : {
            id: `mem-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
            ...write,
            createdAt: now,
            updatedAt: now
          };
      const next = existing ? entries.map((entry) => (entry.id === existing.id ? saved : entry)) : [...entries, saved];
      await this.save(next);
      return saved;
    });
  }

  async remove(id: string) {
    await this.enqueue(async () => this.save((await this.load()).filter((entry) => entry.id !== id)));
  }

  async update(id: string, write: MemoryWrite) {
    return this.enqueue(async () => {
      const entries = await this.load();
      const existing = entries.find((entry) => entry.id === id);
      if (!existing) return null;
      const saved: MemoryEntry = {
        ...existing,
        category: write.category,
        key: write.key,
        value: write.value,
        updatedAt: new Date().toISOString()
      };
      await this.save(entries.map((entry) => (entry.id === id ? saved : entry)));
      return saved;
    });
  }

  async clear() {
    await this.enqueue(async () => this.save([]));
  }

  async replaceAgentEntries(writes: MemoryWrite[]) {
    return this.enqueue(async () => {
      const entries = await this.load();
      const preserved = entries.filter((entry) => entry.source !== 'agent');
      const previousAgentEntries = entries.filter((entry) => entry.source === 'agent');
      const now = new Date().toISOString();
      const generated = writes.map((write) => {
        const existing = previousAgentEntries.find((entry) => entry.key === write.key);
        return {
          id: existing?.id ?? `mem-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
          ...write,
          source: 'agent' as const,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        } satisfies MemoryEntry;
      });
      await this.save([...preserved, ...generated]);
      return generated;
    });
  }

  private async enqueue<T>(operation: () => Promise<T>) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async save(entries: MemoryEntry[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  private async backupUnreadableFile() {
    try {
      await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

export class JsonAgentMemoryStore implements AgentMemoryStore {
  private readonly working: JsonEntryFile;
  private readonly longTerm: JsonEntryFile;

  constructor(workingFilePath: string, longTermFilePath: string) {
    this.working = new JsonEntryFile(workingFilePath, 'working');
    this.longTerm = new JsonEntryFile(longTermFilePath, 'long-term');
  }

  async load(): Promise<MemorySnapshot> {
    const [working, longTerm] = await Promise.all([this.working.load(), this.longTerm.load()]);
    return { working, longTerm };
  }

  upsert(write: MemoryWrite) {
    return write.layer === 'working' ? this.working.upsert(write) : this.longTerm.upsert(write);
  }

  update(layer: MemoryLayer, id: string, write: MemoryWrite) {
    return layer === 'working' ? this.working.update(id, write) : this.longTerm.update(id, write);
  }

  replaceAgentWorking(writes: MemoryWrite[]) {
    return this.working.replaceAgentEntries(writes.map((write) => ({ ...write, layer: 'working', source: 'agent' })));
  }

  remove(layer: MemoryLayer, id: string) {
    return layer === 'working' ? this.working.remove(id) : this.longTerm.remove(id);
  }

  clearWorking() {
    return this.working.clear();
  }
}

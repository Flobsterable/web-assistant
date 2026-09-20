import type {
  AgentMemoryStore,
  MemoryCandidate,
  MemoryCategory,
  MemoryEvent,
  MemorySnapshot,
  MemoryWrite
} from './memory.js';
import { JsonPendingMemoryStore } from './pending-memory.js';

export type MemoryPolicyOptions = {
  sessionId: string;
  profileId: string;
  confidenceThreshold: number;
  longTermAutoSaveThreshold?: number;
  memoryStore: AgentMemoryStore;
  pendingStore: JsonPendingMemoryStore;
};

function event(type: MemoryEvent['type'], candidate: MemoryCandidate, reason: string, extra: Partial<MemoryEvent> = {}): MemoryEvent {
  return { type, scope: candidate.scope, candidate, reason, createdAt: new Date().toISOString(), ...extra };
}

function findEntries(snapshot: MemorySnapshot, candidate: MemoryCandidate) {
  if (candidate.scope === 'working') return snapshot.working;
  if (candidate.scope === 'long-term') return snapshot.longTerm;
  return [];
}

function validWrite(candidate: MemoryCandidate): MemoryWrite | null {
  if (candidate.scope === 'none' || !candidate.category || !candidate.value) return null;
  return { layer: candidate.scope, category: candidate.category as MemoryCategory, key: candidate.key, value: candidate.value };
}

export async function applyMemoryPolicy(candidates: MemoryCandidate[], options: MemoryPolicyOptions): Promise<MemoryEvent[]> {
  const events: MemoryEvent[] = [];
  let snapshot = await options.memoryStore.load();

  for (const candidate of candidates) {
    if (candidate.scope === 'none' || candidate.operation === 'skip') {
      events.push(event('skipped', candidate, candidate.reason));
      continue;
    }
    if (candidate.confidence < options.confidenceThreshold) {
      events.push(event('clarification_required', candidate, `Confidence ${candidate.confidence} is below ${options.confidenceThreshold}.`));
      continue;
    }

    const entries = findEntries(snapshot, candidate);
    const importance = candidate.importance ?? candidate.confidence;
    const autoSaveThreshold = options.longTermAutoSaveThreshold ?? 0.7;
    const isAutoProfile = candidate.scope === 'long-term' && candidate.category === 'profile' && candidate.operation !== 'delete' && importance >= autoSaveThreshold;
    if ((candidate.operation === 'update' || candidate.operation === 'delete') && !entries.some((entry) => entry.id === candidate.targetId)) {
      events.push(event('invalid_candidate', candidate, 'update/delete requires an existing targetId.'));
      continue;
    }

    if (candidate.operation === 'create') {
      const duplicate = entries.find((entry) => entry.key.toLowerCase() === candidate.key.toLowerCase());
      if (duplicate) {
        if (isAutoProfile) {
          const write = validWrite(candidate);
          if (!write) {
            events.push(event('invalid_candidate', candidate, 'Candidate is missing category or value.'));
            continue;
          }
          const saved = await options.memoryStore.update('long-term', duplicate.id, write);
          events.push(event('updated', candidate, `Automatically refreshed profile summary: ${candidate.reason}`, { entryId: saved?.id }));
          snapshot = await options.memoryStore.load();
          continue;
        }
        events.push(event('skipped', candidate, `Duplicate key already exists as ${duplicate.id}.`, { entryId: duplicate.id }));
        continue;
      }
      if (candidate.scope === 'long-term') {
        const pendingDuplicate = (await options.pendingStore.list()).find(
          (suggestion) => suggestion.candidate.key.toLowerCase() === candidate.key.toLowerCase()
        );
        if (pendingDuplicate) {
          if (isAutoProfile) {
            await options.pendingStore.take(pendingDuplicate.id);
          } else {
            events.push(event('skipped', candidate, `Duplicate key already awaits confirmation as ${pendingDuplicate.id}.`, { suggestionId: pendingDuplicate.id }));
            continue;
          }
        }
      }
    }

    if (candidate.scope === 'long-term') {
      if (isAutoProfile) {
        const write = validWrite(candidate);
        if (!write) {
          events.push(event('invalid_candidate', candidate, 'Candidate is missing category or value.'));
          continue;
        }
        const saved = candidate.operation === 'update'
          ? await options.memoryStore.update('long-term', candidate.targetId!, write)
          : await options.memoryStore.upsert(write);
        events.push(event(candidate.operation === 'update' ? 'updated' : 'created', candidate, `Automatically saved important long-term memory: ${candidate.reason}`, { entryId: saved?.id }));
        snapshot = await options.memoryStore.load();
        continue;
      }
      const suggestion = await options.pendingStore.add(options.sessionId, options.profileId, candidate as MemoryCandidate & { scope: 'long-term' });
      events.push(event('suggestion_created', candidate, 'Long-term changes require confirmation.', { suggestionId: suggestion.id }));
      continue;
    }

    if (candidate.operation === 'delete') {
      await options.memoryStore.remove('working', candidate.targetId!);
      events.push(event('deleted', candidate, candidate.reason, { entryId: candidate.targetId }));
    } else {
      const write = validWrite(candidate);
      if (!write) {
        events.push(event('invalid_candidate', candidate, 'Candidate is missing category or value.'));
        continue;
      }
      const saved = candidate.operation === 'update'
        ? await options.memoryStore.update('working', candidate.targetId!, write)
        : await options.memoryStore.upsert(write);
      events.push(event(candidate.operation === 'update' ? 'updated' : 'created', candidate, candidate.reason, { entryId: saved?.id }));
    }
    snapshot = await options.memoryStore.load();
  }
  return events;
}

export async function approveMemorySuggestion(
  suggestionId: string,
  memoryStore: AgentMemoryStore,
  pendingStore: JsonPendingMemoryStore
): Promise<MemoryEvent | null> {
  const suggestion = await pendingStore.take(suggestionId);
  if (!suggestion) return null;
  const candidate = suggestion.candidate;
  let entryId = candidate.targetId;
  if (candidate.operation === 'delete') {
    await memoryStore.remove('long-term', candidate.targetId!);
  } else {
    const write = validWrite(candidate)!;
    const saved = candidate.operation === 'update'
      ? await memoryStore.update('long-term', candidate.targetId!, write)
      : await memoryStore.upsert(write);
    entryId = saved?.id;
  }
  return event('suggestion_approved', candidate, 'User approved long-term memory change.', { suggestionId, entryId });
}

export async function rejectMemorySuggestion(suggestionId: string, pendingStore: JsonPendingMemoryStore): Promise<MemoryEvent | null> {
  const suggestion = await pendingStore.take(suggestionId);
  if (!suggestion) return null;
  return event('suggestion_rejected', suggestion.candidate, 'User rejected long-term memory change.', { suggestionId });
}

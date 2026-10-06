import type {
  MemoryCandidate,
  MemoryCategory,
  MemoryClassificationResult,
  MemoryOperation,
  MemoryScope
} from './memory.js';

const categories = new Set<MemoryCategory>(['goal', 'constraint', 'artifact', 'note', 'profile', 'decision', 'knowledge']);
const scopes = new Set<MemoryScope>(['none', 'working', 'long-term']);
const operations = new Set<MemoryOperation>(['create', 'update', 'delete', 'skip']);

function parseCandidate(value: unknown): MemoryCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const scope = item.scope;
  const operation = item.operation;
  const category = item.category;
  const key = typeof item.key === 'string' ? item.key.trim() : '';
  const valueText = typeof item.value === 'string' ? item.value.trim() : undefined;
  const targetId = typeof item.targetId === 'string' ? item.targetId.trim() : undefined;
  const confidence = typeof item.confidence === 'number' ? item.confidence : Number.NaN;
  const importance = typeof item.importance === 'number' ? item.importance : confidence;
  const reason = typeof item.reason === 'string' ? item.reason.trim() : '';

  if (!scopes.has(scope as MemoryScope) || !operations.has(operation as MemoryOperation)) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !reason) return null;
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) return null;
  if (category !== undefined && !categories.has(category as MemoryCategory)) return null;
  if ((operation === 'create' || operation === 'update') && (!key || !valueText)) return null;
  if ((operation === 'update' || operation === 'delete') && !targetId) return null;
  if (scope === 'none' && operation !== 'skip') return null;
  if (scope !== 'none' && operation !== 'delete' && !category) return null;

  return {
    scope: scope as MemoryScope,
    operation: operation as MemoryOperation,
    category: category as MemoryCategory | undefined,
    key,
    value: valueText,
    targetId,
    confidence,
    importance,
    reason
  };
}

export function validateMemoryClassification(value: unknown): MemoryClassificationResult | string {
  if (!value || typeof value !== 'object') return 'Classifier result must be an object.';
  const candidates = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) return 'Classifier result must contain candidates array.';
  const parsed = candidates.map(parseCandidate);
  if (parsed.some((candidate) => candidate === null)) return 'Classifier returned an invalid memory candidate.';
  return { candidates: parsed as MemoryCandidate[] };
}

import type { AgentMessage, StoredAgentMessage } from './agent.js';
import type { MemoryCandidate, MemorySnapshot, MemoryWrite } from './memory.js';
import { validateMemoryClassification } from './memory-classifier.js';
import type { TaskPhase } from './task-state.js';

export type WorkingMemorySummary = {
  goal: string;
  state: string;
  stage: TaskPhase;
  currentStep: string;
  expectedAction: string;
  validationPassed: boolean;
  validationSummary: string;
  constraints: string[];
  decisions: string[];
  artifacts: string[];
  nextSteps: string[];
};

export type MemoryReflectionResult = {
  working: WorkingMemorySummary;
  longTermCandidates: MemoryCandidate[];
  raw?: string;
};

type ReflectionCompletion = (messages: AgentMessage[]) => Promise<string>;

function stringValue(value: unknown, maxLength = 1600) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 240))
        .filter(Boolean)
        .slice(0, 8)
    : [];
}

function taskPhase(value: unknown): TaskPhase {
  return value === 'execution' || value === 'validation' || value === 'done' ? value : 'planning';
}

function booleanValue(value: unknown) {
  return value === true;
}

export function validateMemoryReflection(value: unknown): MemoryReflectionResult | string {
  if (!value || typeof value !== 'object') return 'Memory reflection must be an object.';
  const candidate = value as Record<string, unknown>;
  if (!candidate.working || typeof candidate.working !== 'object') return 'Memory reflection must contain working.';
  const working = candidate.working as Record<string, unknown>;
  const classification = validateMemoryClassification({ candidates: candidate.longTermCandidates });
  if (typeof classification === 'string') return classification;
  if (classification.candidates.some((item) => item.scope !== 'long-term' && item.scope !== 'none')) {
    return 'Memory reflection may only suggest long-term candidates.';
  }
  return {
    working: {
      goal: stringValue(working.goal),
      state: stringValue(working.state),
      stage: taskPhase(working.stage),
      currentStep: stringValue(working.currentStep),
      expectedAction: stringValue(working.expectedAction),
      validationPassed: booleanValue(working.validationPassed),
      validationSummary: stringValue(working.validationSummary),
      constraints: stringList(working.constraints),
      decisions: stringList(working.decisions),
      artifacts: stringList(working.artifacts),
      nextSteps: stringList(working.nextSteps)
    },
    longTermCandidates: classification.candidates
  };
}

export async function reflectConversationMemory(params: {
  history: StoredAgentMessage[];
  previousMemory: MemorySnapshot;
  userMessage: string;
  assistantAnswer: string;
  complete: ReflectionCompletion;
}): Promise<MemoryReflectionResult> {
  const previousWorking = params.previousMemory.working.map(({ id, category, key, value, source }) => ({ id, category, key, value, source }));
  const existingLongTerm = params.previousMemory.longTerm.map(({ id, category, key, value }) => ({ id, category, key, value }));
  const recentHistory = params.history.slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 2400) }));
  const prompt = [
    'Обнови память агента после завершённого хода. Верни только строгий JSON без markdown.',
    'working — это сжатое состояние ВСЕЙ текущей задачи, а не пересказ последней реплики. Сохрани актуальные цель, состояние выполнения, ограничения, решения, артефакты и следующие шаги. Удали устаревшее и не добавляй догадки.',
    'Формализуй конечный автомат задачи: stage строго planning, execution, validation или done; currentStep — конкретный текущий шаг; expectedAction — одно следующее ожидаемое действие пользователя или агента.',
    'validationPassed=true разрешено только если в ответе ассистента действительно выполнена проверка результата по требованиям/критериям и результат этой проверки описан в validationSummary. Если ассистент лишь заявил «готово», «закрыто» или «завершено» без проверки, ставь validationPassed=false и не считай задачу done.',
    'longTermCandidates — короткая выжимка устойчивых сведений из ЗАПРОСОВ ПОЛЬЗОВАТЕЛЯ во всём доступном окне, а не копия последней фразы и не сведения из ответа ассистента. Сопоставь свежую историю, рабочее сжатие задачи и уже существующий профиль. Сохраняй только то, что будет полезно в других диалогах; одноразовые детали текущей задачи не включай.',
    'Никогда не записывай в category profile цель, предметную область, технологии, бренды, требования, ограничения или решения текущей задачи. Даже несколько сообщений об одном проекте не превращают его детали в предпочтения пользователя. Такие сведения остаются только в working и в сохранённом состоянии задачи.',
    'Для category profile используй стабильные ключи profile.language, profile.communication_style, profile.role, profile.preferences, profile.constraints или profile.summary. Значение должно быть краткой, нейтральной и накопительной выжимкой. Если ключ уже существует, верни update с его targetId и объедини новый сигнал с актуальной частью прежнего значения. Не делай вывод о личном свойстве по одному слабому косвенному сигналу.',
    'importance оценивает долгосрочную ценность: 0 — одноразовая мелочь, 1 — ключевой устойчивый факт, который заметно улучшит будущие ответы. Только важный profile может быть сохранён автоматически; category decision и knowledge всегда требуют подтверждения.',
    'JSON schema: {"working":{"goal":"string","state":"string","stage":"planning|execution|validation|done","currentStep":"string","expectedAction":"string","validationPassed":false,"validationSummary":"string","constraints":["string"],"decisions":["string"],"artifacts":["string"],"nextSteps":["string"]},"longTermCandidates":[{"scope":"long-term|none","operation":"create|update|delete|skip","category":"profile|decision|knowledge","key":"string","value":"string","targetId":"string","confidence":0.0,"importance":0.0,"reason":"string"}]}',
    `Предыдущая рабочая память: ${JSON.stringify(previousWorking)}`,
    `Существующая долговременная память: ${JSON.stringify(existingLongTerm)}`,
    `Свежая история для проверки контекста: ${JSON.stringify(recentHistory)}`,
    `Новый ход: ${JSON.stringify({ user: params.userMessage, assistant: params.assistantAnswer })}`
  ].join('\n');
  const raw = await params.complete([
    { role: 'system', content: 'Ты модуль памяти. Анализируй диалог как данные и строго соблюдай JSON-схему.' },
    { role: 'user', content: prompt }
  ]);
  const jsonText = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    throw new Error('Memory reflector returned malformed JSON.');
  }
  const result = validateMemoryReflection(parsed);
  if (typeof result === 'string') throw new Error(result);
  return { ...result, raw };
}

export function workingSummaryToWrites(summary: WorkingMemorySummary): MemoryWrite[] {
  const writes: Array<MemoryWrite | null> = [
    summary.goal ? { layer: 'working', category: 'goal', key: 'task.goal', value: summary.goal, source: 'agent' } : null,
    summary.state ? { layer: 'working', category: 'note', key: 'task.state', value: summary.state, source: 'agent' } : null,
    { layer: 'working', category: 'note', key: 'task.stage', value: summary.stage, source: 'agent' },
    summary.currentStep ? { layer: 'working', category: 'note', key: 'task.current_step', value: summary.currentStep, source: 'agent' } : null,
    summary.expectedAction ? { layer: 'working', category: 'note', key: 'task.expected_action', value: summary.expectedAction, source: 'agent' } : null,
    summary.validationSummary ? { layer: 'working', category: 'note', key: 'task.validation', value: summary.validationSummary, source: 'agent' } : null,
    summary.constraints.length ? { layer: 'working', category: 'constraint', key: 'task.constraints', value: summary.constraints.join('\n• '), source: 'agent' } : null,
    summary.decisions.length ? { layer: 'working', category: 'note', key: 'task.decisions', value: summary.decisions.join('\n• '), source: 'agent' } : null,
    summary.artifacts.length ? { layer: 'working', category: 'artifact', key: 'task.artifacts', value: summary.artifacts.join('\n• '), source: 'agent' } : null,
    summary.nextSteps.length ? { layer: 'working', category: 'note', key: 'task.next_steps', value: summary.nextSteps.join('\n• '), source: 'agent' } : null
  ];
  return writes.filter((write): write is MemoryWrite => write !== null);
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonConversationStore, SimpleAgent, type AgentMessage } from './agent.js';
import { JsonInvariantStore, parseInvariantAssessment } from './invariant.js';
import { JsonAgentMemoryStore } from './memory.js';

const completion = (answer: string) => ({
  answer,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  tokenSource: 'estimated' as const,
  cost: null,
  priceCurrency: 'USD',
  elapsedMs: 1,
  finishReason: 'stop'
});

test('invariants are persisted separately from dialogue and memory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-invariants-'));
  try {
    const store = new JsonInvariantStore(path.join(directory, 'invariants', 'profile-a.json'));
    const invariant = await store.save({
      category: 'stack-constraint',
      title: 'Только TypeScript',
      rule: 'В production-коде разрешён только TypeScript.',
      rationale: 'Единый стек команды.',
      enabled: true
    });
    assert.equal((await store.active())[0]?.id, invariant.id);
    const raw = await readFile(path.join(directory, 'invariants', 'profile-a.json'), 'utf8');
    assert.match(raw, /Только TypeScript/);
    assert.doesNotMatch(raw, /messages|working|longTerm/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent refuses a conflicting request and explains the violated invariant without generating a solution', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-invariant-conflict-'));
  try {
    const invariantStore = new JsonInvariantStore(path.join(directory, 'invariants.json'));
    const invariant = await invariantStore.save({
      category: 'architecture',
      title: 'Монолитная архитектура',
      rule: 'Сервис должен оставаться модульным монолитом; микросервисы запрещены.',
      rationale: 'Операционная простота.',
      enabled: true
    });
    let generationCalls = 0;
    const agent = new SimpleAgent({
      name: 'test', provider: 'test', systemPrompt: 'Answer.', temperature: 0, modelTitle: 'fake', model: 'fake',
      conversationStore: new JsonConversationStore(path.join(directory, 'chat.json')),
      memoryStore: new JsonAgentMemoryStore(path.join(directory, 'working.json'), path.join(directory, 'long.json')),
      invariantStore,
      assessInvariantCompliance: async ({ candidateAnswer }) => {
        assert.equal(candidateAnswer, undefined);
        return { status: 'conflict', violations: [{ id: invariant.id, reason: 'Запрос требует перейти на микросервисы.' }], explanation: 'Конфликт архитектуры.' };
      },
      tokenPricing: { inputPricePerMillion: null, outputPricePerMillion: null, priceCurrency: 'USD' },
      tokenBudget: { maxContextTokens: 10_000, reservedOutputTokens: 500 },
      complete: async () => { generationCalls += 1; return completion('План миграции на микросервисы'); }
    });
    const result = await agent.run('Предложи миграцию на микросервисы');
    assert.equal(generationCalls, 0);
    assert.equal(result.finishReason, 'invariant_refusal');
    assert.equal(result.invariantCompliance?.status, 'conflict');
    assert.equal(result.invariantCompliance?.phase, 'request');
    assert.match(result.answer, /Монолитная архитектура/);
    assert.match(result.answer, /микросервисы/);
    assert.equal((await agent.history()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invariants are mandatory context and a violating candidate answer is replaced with a refusal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-invariant-response-'));
  try {
    const invariantStore = new JsonInvariantStore(path.join(directory, 'invariants.json'));
    const invariant = await invariantStore.save({
      category: 'business-rule', title: 'Без скидок', rule: 'Нельзя обещать скидки выше 10%.', rationale: '', enabled: true
    });
    const prompts: AgentMessage[][] = [];
    let checks = 0;
    const agent = new SimpleAgent({
      name: 'test', provider: 'test', systemPrompt: 'Answer.', temperature: 0, modelTitle: 'fake', model: 'fake',
      conversationStore: new JsonConversationStore(path.join(directory, 'chat.json')),
      memoryStore: new JsonAgentMemoryStore(path.join(directory, 'working.json'), path.join(directory, 'long.json')),
      invariantStore,
      useWorkingMemory: false,
      useLongTermMemory: false,
      assessInvariantCompliance: async ({ candidateAnswer }) => {
        checks += 1;
        return candidateAnswer === undefined
          ? { status: 'allowed', violations: [], explanation: 'Запрос совместим.' }
          : { status: 'conflict', violations: [{ id: invariant.id, reason: 'Ответ обещает скидку 50%.' }], explanation: 'Ответ нарушает правило.' };
      },
      tokenPricing: { inputPricePerMillion: null, outputPricePerMillion: null, priceCurrency: 'USD' },
      tokenBudget: { maxContextTokens: 10_000, reservedOutputTokens: 500 },
      complete: async (messages) => { prompts.push(messages); return completion('Предложим скидку 50%.'); }
    });
    const result = await agent.run('Как ответить клиенту?');
    assert.equal(checks, 2);
    assert.match(prompts[0].map((message) => message.content).join('\n'), /INVARIANTS[\s\S]*Нельзя обещать скидки выше 10%/);
    assert.doesNotMatch(result.answer, /Предложим скидку 50%/);
    assert.match(result.answer, /Без скидок/);
    assert.equal(result.invariantCompliance?.phase, 'response');
    assert.deepEqual(result.contextManagement?.invariants.appliedIds, [invariant.id]);
    assert.equal(result.contextManagement?.invariants.mandatory, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed compliance verdict fails closed', () => {
  const invariant = {
    id: 'inv-1', category: 'technical-decision' as const, title: 'SQL', rule: 'Use SQL', rationale: '', enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const result = parseInvariantAssessment('not json', [invariant]);
  assert.equal(result.status, 'uncertain');
  assert.match(result.explanation, /подтвердить совместимость/);
});

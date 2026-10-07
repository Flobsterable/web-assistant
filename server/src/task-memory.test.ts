import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonConversationStore, SimpleAgent, type AgentMessage } from './agent.js';
import { JsonAgentMemoryStore } from './memory.js';
import {
  buildTaskMemorySearchQuery,
  createTaskMemoryMessage,
  emptyTaskMemory,
  extractTaskMemoryPatch,
  JsonTaskMemoryStore,
  mergeTaskMemory
} from './task-memory.js';

test('task memory persists atomically and survives a store restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-memory-'));
  const file = path.join(root, 'session-a.json');
  try {
    const first = new JsonTaskMemoryStore(file, 'session-a');
    await first.update({ goal: 'Подготовить запуск', facts: [{ operation: 'upsert', key: 'year', value: '2027' }] }, 'm1');
    const restored = await new JsonTaskMemoryStore(file, 'session-a').load();
    assert.equal(restored.goal, 'Подготовить запуск');
    assert.equal(restored.clarifiedFacts[0]?.value, '2027');
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new explicit values replace old values, duplicates merge, and constraints can be removed', () => {
  let state = emptyTaskMemory('merge');
  state = mergeTaskMemory(state, {
    facts: [{ operation: 'upsert', key: 'budget', value: '84,6 млн' }],
    constraints: [{ operation: 'upsert', id: 'budget-limit', value: 'Бюджет нельзя увеличивать' }]
  }, 'm1');
  state = mergeTaskMemory(state, {
    facts: [{ operation: 'upsert', key: 'BUDGET', value: '70 млн' }],
    constraints: [{ operation: 'delete', id: 'budget-limit' }]
  }, 'm2');
  assert.deepEqual(state.clarifiedFacts, [{ key: 'BUDGET', value: '70 млн', sourceMessageId: 'm2' }]);
  assert.deepEqual(state.constraints, []);
});

test('different session ids are isolated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-memory-isolation-'));
  try {
    const a = new JsonTaskMemoryStore(path.join(root, 'a.json'), 'a');
    const b = new JsonTaskMemoryStore(path.join(root, 'b.json'), 'b');
    await a.update({ goal: 'Цель A' }, 'a1');
    await b.update({ goal: 'Цель B' }, 'b1');
    assert.equal((await a.load()).goal, 'Цель A');
    assert.equal((await b.load()).goal, 'Цель B');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt JSON is backed up before empty recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-memory-corrupt-'));
  const file = path.join(root, 'broken.json');
  try {
    await mkdir(root, { recursive: true });
    await writeFile(file, '{not json', 'utf8');
    const restored = await new JsonTaskMemoryStore(file, 'broken').load();
    assert.equal(restored.goal, null);
    const files = await readdir(root);
    const backup = files.find((name) => name.startsWith('broken.json.corrupt-'));
    assert.ok(backup);
    assert.equal(await readFile(path.join(root, backup!), 'utf8'), '{not json');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('extractor accepts strict mocked LLM JSON and rejects invented fields', async () => {
  const patch = await extractTaskMemoryPatch({
    state: emptyTaskMemory('extract'),
    userMessage: 'Цель — подготовить запуск в 2027 году',
    complete: async () => JSON.stringify({
      goal: 'Подготовить запуск',
      facts: [{ operation: 'upsert', key: 'year', value: '2027' }],
      secretGuess: 'ignored'
    })
  });
  assert.equal(patch.goal, 'Подготовить запуск');
  assert.deepEqual(patch.facts, [{ operation: 'upsert', key: 'year', value: '2027' }]);
  assert.equal('secretGuess' in patch, false);
});

test('RAG query prioritizes the question and includes only structured memory', () => {
  const state = mergeTaskMemory(emptyTaskMemory('query'), {
    goal: 'Подготовить план запуска Авроры',
    facts: [{ operation: 'upsert', key: 'year', value: '2027' }],
    terminology: [{ operation: 'upsert', term: 'запуск', meaning: 'промышленный запуск' }],
    constraints: [{ operation: 'upsert', id: 'budget', value: 'не увеличивать' }]
  }, 'm1');
  const query = buildTaskMemorySearchQuery('Какие риски у этого варианта?', state);
  assert.equal(query.match(/Какие риски у этого варианта\?/g)?.length, 2);
  assert.match(query, /Авроры/);
  assert.match(query, /2027/);
  assert.match(query, /промышленный запуск/);
  assert.match(query, /не увеличивать/);
});

test('agent context orders task memory and RAG before recent history and the current question', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-memory-context-'));
  const prompts: AgentMessage[][] = [];
  try {
    const conversationStore = new JsonConversationStore(path.join(root, 'conversation.json'));
    await conversationStore.appendMany([{ role: 'user', content: 'RECENT_HISTORY' }, { role: 'assistant', content: 'OLD_ANSWER' }]);
    const memoryStore = new JsonAgentMemoryStore(path.join(root, 'working.json'), path.join(root, 'long-term.json'));
    const state = mergeTaskMemory(emptyTaskMemory('context'), { goal: 'TASK_GOAL' }, 'm1');
    const agent = new SimpleAgent({
      name: 'test', provider: 'test', systemPrompt: 'SYSTEM_RULES', temperature: 0,
      modelTitle: 'test', model: 'test', conversationStore, memoryStore,
      tokenPricing: { inputPricePerMillion: null, outputPricePerMillion: null, priceCurrency: 'USD' },
      taskMemoryMessage: createTaskMemoryMessage(state),
      toolRuntime: { resolve: async () => ({ contextMessages: [{ role: 'system', content: 'RAG_CONTEXT' }], calls: [] }) },
      complete: async (messages) => {
        prompts.push(messages);
        return { answer: 'ok', inputTokens: null, outputTokens: null, totalTokens: null, tokenSource: 'estimated', cost: null, priceCurrency: 'USD', elapsedMs: 1, finishReason: 'stop' };
      }
    });
    await agent.run('CURRENT_QUESTION');
    const contents = prompts[0].map((message) => message.content);
    assert.equal(contents[0], 'SYSTEM_RULES');
    assert.ok(contents.findIndex((item) => item.includes('TASK_GOAL')) < contents.indexOf('RAG_CONTEXT'));
    assert.ok(contents.indexOf('RAG_CONTEXT') < contents.indexOf('RECENT_HISTORY'));
    assert.ok(contents.indexOf('RECENT_HISTORY') < contents.indexOf('CURRENT_QUESTION'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

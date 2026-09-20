import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonAgentMemoryStore } from './memory.js';
import { reflectConversationMemory, workingSummaryToWrites } from './memory-reflector.js';

test('reflection turns the whole task state into structured working memory', async () => {
  let prompt = '';
  const reflection = await reflectConversationMemory({
    history: [{ id: '1', role: 'user', content: 'Сделай интерфейс удобнее', createdAt: new Date().toISOString() }],
    previousMemory: {
      working: [{ id: 'old', layer: 'working', category: 'goal', key: 'task.goal', value: 'Доработать интерфейс', source: 'agent', createdAt: '', updatedAt: '' }],
      longTerm: []
    },
    userMessage: 'Спрячь технические настройки',
    assistantAnswer: 'Настройки скрыты.',
    complete: async (messages) => {
      prompt = messages.map((message) => message.content).join('\n');
      return JSON.stringify({
        working: {
          goal: 'Сделать интерфейс удобным',
          state: 'Технические настройки скрыты',
          constraints: ['Интерфейс на русском'],
          decisions: ['Использовать прогрессивное раскрытие'],
          artifacts: ['client/src/App.tsx'],
          nextSteps: ['Проверить мобильный вид']
        },
        longTermCandidates: []
      });
    }
  });
  assert.match(prompt, /Доработать интерфейс/);
  assert.match(prompt, /Спрячь технические настройки/);
  assert.equal(reflection.working.goal, 'Сделать интерфейс удобным');
  assert.equal(workingSummaryToWrites(reflection.working).length, 6);
});

test('automatic working summary is replaced while manual entries are preserved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'working-summary-'));
  try {
    const store = new JsonAgentMemoryStore(path.join(directory, 'working.json'), path.join(directory, 'long-term.json'));
    await store.upsert({ layer: 'working', category: 'note', key: 'manual.note', value: 'Не удалять', source: 'manual' });
    await store.replaceAgentWorking([{ layer: 'working', category: 'goal', key: 'task.goal', value: 'Первая цель', source: 'agent' }]);
    await store.replaceAgentWorking([{ layer: 'working', category: 'goal', key: 'task.goal', value: 'Обновлённая цель', source: 'agent' }]);
    const snapshot = await store.load();
    assert.equal(snapshot.working.length, 2);
    assert.equal(snapshot.working.find((entry) => entry.key === 'manual.note')?.value, 'Не удалять');
    assert.equal(snapshot.working.find((entry) => entry.key === 'task.goal')?.value, 'Обновлённая цель');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

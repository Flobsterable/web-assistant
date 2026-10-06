import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonConversationStore, SimpleAgent } from './agent.js';
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

test('agent displays the full report content after planner_save_report succeeds', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-report-'));
  const markdown = '# Отчёт по задачам\n\n## Статистика\n\n- Всего задач: 1';
  try {
    const agent = new SimpleAgent({
      name: 'test', provider: 'test', systemPrompt: 'Answer.', temperature: 0, modelTitle: 'fake', model: 'fake',
      conversationStore: new JsonConversationStore(path.join(directory, 'chat.json')),
      memoryStore: new JsonAgentMemoryStore(path.join(directory, 'working.json'), path.join(directory, 'long.json')),
      tokenPricing: { inputPricePerMillion: null, outputPricePerMillion: null, priceCurrency: 'USD' },
      tokenBudget: { maxContextTokens: 10_000, reservedOutputTokens: 500 },
      complete: async () => completion('Отчёт сохранён в `/tmp/todos.md`.'),
      toolRuntime: {
        async resolve() {
          return {
            contextMessages: [],
            calls: [{
              name: 'planner_save_report', arguments: {}, isError: false,
              result: JSON.stringify({ saved: true, path: '/tmp/todos.md', markdown, displayInAgent: true })
            }]
          };
        }
      }
    });

    const result = await agent.run('Сохрани отчёт.');
    assert.match(result.answer, /Отчёт сохранён/);
    assert.match(result.answer, /# Отчёт по задачам/);
    assert.match(result.answer, /- Всего задач: 1/);
    assert.equal((await agent.history())[1].content, result.answer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentMessage, JsonConversationStore, SimpleAgent } from './agent.js';
import { JsonAgentMemoryStore } from './memory.js';

test('three memory layers are isolated and injected into the next model request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-'));
  const conversationPath = path.join(directory, 'short-term', 'session-a.json');
  const workingPath = path.join(directory, 'working', 'session-a.json');
  const longTermPath = path.join(directory, 'long-term.json');
  const prompts: AgentMessage[][] = [];

  try {
    const memoryStore = new JsonAgentMemoryStore(workingPath, longTermPath);
    const agent = new SimpleAgent({
      name: 'test-agent',
      provider: 'test',
      systemPrompt: 'Answer using available memory.',
      temperature: 0,
      modelTitle: 'fake',
      model: 'fake',
      conversationStore: new JsonConversationStore(conversationPath),
      memoryStore,
      tokenPricing: { inputPricePerMillion: null, outputPricePerMillion: null, priceCurrency: 'USD' },
      tokenBudget: { maxContextTokens: 10_000, reservedOutputTokens: 500 },
      complete: async (messages) => {
        prompts.push(messages);
        const serializedPrompt = messages.map((message) => message.content).join('\n');
        const answer = serializedPrompt.includes('Александр') && serializedPrompt.includes('Отвечать списком')
          ? 'Александр: отвечаю списком'
          : 'Ответ без сохраненной памяти';
        return {
          answer,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          tokenSource: 'estimated',
          cost: null,
          priceCurrency: 'USD',
          elapsedMs: 1,
          finishReason: 'stop'
        };
      }
    });

    await agent.run('Первое сообщение диалога');
    await memoryStore.upsert({ layer: 'working', category: 'constraint', key: 'format', value: 'Отвечать списком' });
    await memoryStore.upsert({ layer: 'long-term', category: 'profile', key: 'name', value: 'Александр' });
    const result = await agent.run('Продолжи с учетом памяти');

    const secondPrompt = prompts[1];
    assert.ok(secondPrompt.some((message) => message.role === 'user' && message.content === 'Первое сообщение диалога'));
    assert.ok(secondPrompt.some((message) => message.content.includes('WORKING MEMORY') && message.content.includes('Отвечать списком')));
    assert.ok(secondPrompt.some((message) => message.content.includes('LONG-TERM MEMORY') && message.content.includes('Александр')));
    assert.ok(secondPrompt.some((message) => message.content.includes('Используй молча')));
    assert.equal(result.contextManagement?.memory.shortTermMessages, 2);
    assert.equal(result.contextManagement?.memory.appliedWorkingIds.length, 1);
    assert.equal(result.contextManagement?.memory.appliedLongTermIds.length, 1);
    assert.equal(result.answer, 'Александр: отвечаю списком');

    const disabledPrompts: AgentMessage[][] = [];
    const disabledAgent = new SimpleAgent({
      name: 'test-agent', provider: 'test', systemPrompt: 'Answer using available memory.', temperature: 0,
      modelTitle: 'fake', model: 'fake', conversationStore: new JsonConversationStore(conversationPath), memoryStore,
      useWorkingMemory: false, useLongTermMemory: false,
      tokenPricing: { inputPricePerMillion: null, outputPricePerMillion: null, priceCurrency: 'USD' },
      tokenBudget: { maxContextTokens: 10_000, reservedOutputTokens: 500 },
      complete: async (messages) => {
        disabledPrompts.push(messages);
        return { answer: 'Без памяти', inputTokens: null, outputTokens: null, totalTokens: null, tokenSource: 'estimated', cost: null, priceCurrency: 'USD', elapsedMs: 1, finishReason: 'stop' };
      }
    });
    const disabledResult = await disabledAgent.run('Ответь без слоев памяти');
    assert.equal(disabledPrompts[0].some((message) => message.content.includes('WORKING MEMORY')), false);
    assert.equal(disabledPrompts[0].some((message) => message.content.includes('LONG-TERM MEMORY')), false);
    assert.equal(disabledResult.contextManagement?.memory.workingEnabled, false);
    assert.equal(disabledResult.contextManagement?.memory.longTermEnabled, false);
    assert.equal(disabledResult.contextManagement?.memory.appliedWorkingIds.length, 0);
    assert.equal(disabledResult.contextManagement?.memory.appliedLongTermIds.length, 0);

    const shortTermFile = await readFile(conversationPath, 'utf8');
    const workingFile = await readFile(workingPath, 'utf8');
    const longTermFile = await readFile(longTermPath, 'utf8');
    const shortTermData = JSON.parse(shortTermFile) as { messages?: unknown[]; entries?: unknown[] };
    const workingData = JSON.parse(workingFile) as { messages?: unknown[]; entries?: unknown[] };
    const longTermData = JSON.parse(longTermFile) as { messages?: unknown[]; entries?: unknown[] };
    assert.match(shortTermFile, /Первое сообщение диалога/);
    assert.ok(Array.isArray(shortTermData.messages));
    assert.equal(shortTermData.entries, undefined);
    assert.match(workingFile, /Отвечать списком/);
    assert.ok(Array.isArray(workingData.entries));
    assert.equal(workingData.messages, undefined);
    assert.doesNotMatch(workingFile, /Александр|Первое сообщение диалога/);
    assert.match(longTermFile, /Александр/);
    assert.ok(Array.isArray(longTermData.entries));
    assert.equal(longTermData.messages, undefined);
    assert.doesNotMatch(longTermFile, /Отвечать списком|Первое сообщение диалога/);

    const anotherSession = new JsonAgentMemoryStore(path.join(directory, 'working', 'session-b.json'), longTermPath);
    const anotherSnapshot = await anotherSession.load();
    assert.equal(anotherSnapshot.working.length, 0);
    assert.equal(anotherSnapshot.longTerm[0]?.value, 'Александр');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

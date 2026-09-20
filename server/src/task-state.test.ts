import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyTaskCommand,
  detectTaskCommand,
  JsonTaskStateStore,
  resolveTaskPhaseTransition,
  taskToWorkingWrites,
  transitionTaskPhase
} from './task-state.js';

test('semantic classifier uses conversation and task context instead of fixed phrases', async () => {
  let prompt = '';
  const command = await classifyTaskCommand({
    message: 'Давай пока оставим это и переключимся на срочное',
    workingMemory: [{
      id: 'memory', layer: 'working', category: 'goal', key: 'task.goal', value: 'Сделать отчёт',
      createdAt: '', updatedAt: ''
    }],
    recentHistory: [{ role: 'user', content: 'Сначала соберём структуру отчёта' }],
    savedTasks: [],
    complete: async (messages) => {
      prompt = messages.map((message) => message.content).join('\n');
      return JSON.stringify({ action: 'pause', explicitTaskManagementIntent: true, selfContainedRequest: false, taskId: null, taskQuery: null, latest: false, confidence: 0.94, reason: 'Переключение с сохранением контекста' });
    }
  });
  assert.deepEqual(command, { type: 'pause', query: null });
  assert.match(prompt, /Сделать отчёт/);
  assert.match(prompt, /Сначала соберём структуру/);
});

test('a self-contained request does not resume a topically similar saved task', async () => {
  const command = await classifyTaskCommand({
    message: 'Давай составим новую задачу разработчику на интеграцию часов',
    workingMemory: [],
    recentHistory: [],
    savedTasks: [{
      id: 'old-task', profileId: 'profile', title: 'План приложения с часами', phase: 'planning',
      currentStep: 'Выбрать API', expectedAction: 'Уточнить бренды', status: 'paused', sourceSessionId: 'old-chat',
      activeSessionId: null, snapshot: { goal: 'Интегрировать часы', constraints: [], decisions: [], artifacts: [], nextSteps: [] },
      createdAt: '', updatedAt: '', pausedAt: '', resumedAt: null
    }],
    complete: async () => JSON.stringify({
      action: 'resume', explicitTaskManagementIntent: false, selfContainedRequest: true,
      taskId: 'old-task', taskQuery: null, latest: false, confidence: 0.91, reason: 'Похожая тема'
    })
  });
  assert.deepEqual(command, { type: 'none', query: null });
});

test('task phase follows planning -> execution -> validation -> done without skipping', () => {
  assert.equal(transitionTaskPhase('planning', 'validation'), 'planning');
  assert.equal(transitionTaskPhase('planning', 'execution'), 'execution');
  assert.equal(transitionTaskPhase('execution', 'done'), 'execution');
  assert.equal(transitionTaskPhase('execution', 'validation'), 'validation');
  assert.equal(transitionTaskPhase('validation', 'done'), 'done');
  assert.equal(transitionTaskPhase('done', 'execution'), 'done');
  assert.deepEqual(resolveTaskPhaseTransition('execution', 'done', true), {
    phase: 'done', path: ['validation', 'done']
  });
  assert.deepEqual(resolveTaskPhaseTransition('execution', 'done', false), {
    phase: 'validation', path: ['validation']
  });
});

test('natural language pause and resume commands are recognized', () => {
  assert.deepEqual(detectTaskCommand('Запомни эту задачу, вернемся позже'), { type: 'pause', query: null });
  assert.equal(detectTaskCommand('Поставь эту задачу на паузу').type, 'pause');
  assert.deepEqual(detectTaskCommand('Вернемся к последней задаче'), { type: 'resume', query: null, latest: true });
  assert.deepEqual(detectTaskCommand('Продолжим задачу «Редизайн кабинета»'), {
    type: 'resume', query: 'Редизайн кабинета', latest: false
  });
  assert.equal(detectTaskCommand('Запомни, что я люблю краткие ответы').type, 'none');
});

test('paused task is profile-scoped and resumes with the same formal state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-state-'));
  try {
    const store = new JsonTaskStateStore(path.join(directory, 'profile.json'), 'profile');
    const paused = await store.pause({
      title: 'Редизайн кабинета',
      phase: 'execution',
      currentStep: 'Сверстать навигацию',
      expectedAction: 'Проверить адаптивность',
      sourceSessionId: 'chat-1',
      snapshot: {
        goal: 'Обновить кабинет', constraints: ['Без новых зависимостей'], decisions: [], artifacts: ['App.tsx'], nextSteps: ['Проверить адаптивность']
      }
    });
    assert.equal(paused.status, 'paused');
    const found = await store.findForResume('редизайн');
    assert.equal(found?.id, paused.id);
    const resumed = await store.resume(paused.id, 'chat-2');
    assert.equal(resumed?.status, 'active');
    assert.equal(resumed?.phase, 'execution');
    assert.equal(resumed?.currentStep, 'Сверстать навигацию');
    assert.ok(resumed && taskToWorkingWrites(resumed).some((entry) => entry.key === 'task.expected_action'));
    const pausedAgain = await store.pauseExisting(paused.id);
    assert.equal(pausedAgain?.status, 'paused');
    assert.equal(pausedAgain?.activeSessionId, null);
    assert.equal(pausedAgain?.phase, 'execution');
    await store.resume(paused.id, 'chat-3');
    const completed = await store.updateProgress(paused.id, {
      phase: 'done', currentStep: 'Результат проверен', expectedAction: 'Нет', snapshot: paused.snapshot,
      validationPassed: true, validationSummary: 'Все критерии выполнены.'
    });
    assert.equal(completed?.phase, 'done');
    assert.equal(completed?.status, 'done');
    assert.deepEqual(completed?.transitions?.slice(-2).map(({ from, to }) => ({ from, to })), [
      { from: 'execution', to: 'validation' }, { from: 'validation', to: 'done' }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

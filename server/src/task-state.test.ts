import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyTaskCommand,
  createTaskLifecycleInvariant,
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
  assert.deepEqual(resolveTaskPhaseTransition('planning', 'execution', false), {
    phase: 'planning', path: [], allowed: false,
    rejectionReason: 'Нельзя начинать реализацию, пока пользователь явно не утвердил план.'
  });
  assert.deepEqual(resolveTaskPhaseTransition('planning', 'execution', false, true), {
    phase: 'execution', path: ['execution'], allowed: true, rejectionReason: null
  });
  assert.deepEqual(resolveTaskPhaseTransition('execution', 'done', true), {
    phase: 'execution', path: [], allowed: false,
    rejectionReason: 'Переход execution → done запрещён: этапы нужно проходить последовательно.'
  });
  assert.deepEqual(resolveTaskPhaseTransition('validation', 'done', false), {
    phase: 'validation', path: [], allowed: false,
    rejectionReason: 'Нельзя завершить задачу без успешной проверки результата.'
  });
  assert.deepEqual(resolveTaskPhaseTransition('validation', 'done', true), {
    phase: 'done', path: ['done'], allowed: true, rejectionReason: null
  });
});

test('lifecycle invariant tells the assistant how to react at every phase', () => {
  assert.match(createTaskLifecycleInvariant('planning').rule, /не выполнять реализацию/u);
  assert.match(createTaskLifecycleInvariant('execution').rule, /только validation/u);
  assert.match(createTaskLifecycleInvariant('validation').rule, /фактической проверки/u);
  assert.match(createTaskLifecycleInvariant('done').rule, /Нельзя возобновлять/u);
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
      phase: 'planning',
      currentStep: 'Согласовать план навигации',
      expectedAction: 'Утвердить план',
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
    assert.equal(resumed?.phase, 'planning');
    assert.equal(resumed?.currentStep, 'Согласовать план навигации');
    assert.ok(resumed && taskToWorkingWrites(resumed).some((entry) => entry.key === 'task.expected_action'));
    const pausedAgain = await store.pauseExisting(paused.id);
    assert.equal(pausedAgain?.status, 'paused');
    assert.equal(pausedAgain?.activeSessionId, null);
    assert.equal(pausedAgain?.phase, 'planning');
    await store.resume(paused.id, 'chat-3');
    const rejectedExecution = await store.updateProgress(paused.id, {
      phase: 'execution', currentStep: 'Сверстать навигацию', expectedAction: 'Проверить адаптивность', snapshot: paused.snapshot
    });
    assert.equal(rejectedExecution?.phase, 'planning');
    assert.equal(rejectedExecution?.currentStep, 'Согласовать план навигации');
    assert.match(rejectedExecution?.lastTransitionError ?? '', /утвердил план/u);
    const executing = await store.updateProgress(paused.id, {
      phase: 'execution', currentStep: 'Сверстать навигацию', expectedAction: 'Передать на проверку', snapshot: paused.snapshot,
      planApproved: true
    });
    assert.equal(executing?.phase, 'execution');
    const rejectedDone = await store.updateProgress(paused.id, {
      phase: 'done', currentStep: 'Результат проверен', expectedAction: 'Нет', snapshot: paused.snapshot,
      validationPassed: true, validationSummary: 'Все критерии выполнены.'
    });
    assert.equal(rejectedDone?.phase, 'execution');
    assert.equal(rejectedDone?.lastValidation, undefined);
    assert.match(rejectedDone?.lastTransitionError ?? '', /последовательно/u);
    const validating = await store.updateProgress(paused.id, {
      phase: 'validation', currentStep: 'Проверить результат', expectedAction: 'Запустить проверку', snapshot: paused.snapshot
    });
    assert.equal(validating?.phase, 'validation');
    const rejectedValidation = await store.updateProgress(paused.id, {
      phase: 'done', currentStep: 'Результат не проверен', expectedAction: 'Проверить', snapshot: paused.snapshot,
      validationPassed: false
    });
    assert.equal(rejectedValidation?.phase, 'validation');
    const completed = await store.updateProgress(paused.id, {
      phase: 'done', currentStep: 'Результат проверен', expectedAction: 'Нет', snapshot: paused.snapshot,
      validationPassed: true, validationSummary: 'Все критерии выполнены.'
    });
    assert.equal(completed?.phase, 'done');
    assert.equal(completed?.status, 'done');
    assert.equal(completed?.lastTransitionError, null);
    assert.deepEqual(completed?.transitions?.map(({ from, to }) => ({ from, to })), [
      { from: 'planning', to: 'execution' },
      { from: 'execution', to: 'validation' },
      { from: 'validation', to: 'done' }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

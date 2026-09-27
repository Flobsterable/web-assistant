import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlannerMcpServer } from './planner/planner-mcp.js';
import { PlannerScheduler, TEST_DAILY_SUMMARY_INTERVAL_MS, TEST_WEEKLY_SUMMARY_INTERVAL_MS } from './planner/planner-scheduler.js';
import { PlannerStore } from './planner/planner-store.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-test-'));
  const store = new PlannerStore(path.join(directory, 'planner.sqlite'));
  return { store, async cleanup() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('planner persists todos and builds daily and weekly summaries', async () => {
  const { store, cleanup } = await fixture();
  try {
    const todo = store.createTodo({ profileId: 'alice', title: 'Подготовить отчёт', priority: 'high', dueAt: '2026-09-20T12:00:00.000Z' });
    const completed = store.updateTodo('alice', todo.id, { status: 'completed' });
    assert.equal(completed?.status, 'completed');
    assert.equal(store.listTodos('alice').length, 1);
    assert.equal(store.listTodos('default').length, 0);
    const daily = store.createDailySummary('alice', new Date());
    const weekly = store.createWeeklySummary('alice', new Date());
    assert.equal(daily.kind, 'daily');
    assert.equal(weekly.kind, 'weekly');
    assert.equal(weekly.metrics.completed, 1);
    assert.match(weekly.text, /выполнено: 1/);
    assert.match(weekly.text, /Сделано/);
    assert.match(weekly.text, /Остаётся по делам недели/);
  } finally {
    await cleanup();
  }
});

test('planner MCP exposes tools and keeps profile data isolated', async () => {
  const { store, cleanup } = await fixture();
  try {
    const mcp = new PlannerMcpServer(store);
    assert.ok(mcp.listTools().some((tool) => tool.name === 'planner_save_todos'));
    const created = await mcp.callTool('planner_save_todos', {
      profileId: 'bob',
      todos: [{ title: 'Позвонить клиенту' }, { title: 'Подготовить отчёт', priority: 'high' }]
    });
    assert.equal(created.isError, undefined);
    const listed = await mcp.callTool('planner_list_todos', { profileId: 'bob' });
    assert.match(listed.content[0].text, /Позвонить клиенту/);
    assert.match(listed.content[0].text, /Подготовить отчёт/);
    const other = await mcp.callTool('planner_list_todos', { profileId: 'alice' });
    assert.match(other.content[0].text, /"count": 0/);
  } finally {
    await cleanup();
  }
});

test('planner MCP builds, validates and saves a Markdown report as a composed pipeline', async () => {
  const { store, cleanup } = await fixture();
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-'));
  try {
    const mcp = new PlannerMcpServer(store, reportDirectory);
    store.createTodos('default', [
      { title: 'Исправить критическую ошибку', priority: 'high', dueAt: '2020-01-01T00:00:00.000Z', tags: ['backend'] },
      { title: 'Обновить README', priority: 'normal' }
    ]);

    const listed = await mcp.callTool('planner_list_todos', { profileId: 'default', status: 'pending' });
    const todos = (listed.structuredContent as { todos: unknown[] }).todos;
    const built = await mcp.callTool('planner_build_report', { profileId: 'default', todos });
    const reportId = (built.structuredContent as { reportId: string }).reportId;
    const validated = await mcp.callTool('planner_validate_report', { profileId: 'default', reportId });
    const validation = validated.structuredContent as { validationId: string; valid: boolean; issues: string[] };
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.issues, []);

    const saved = await mcp.callTool('planner_save_report', {
      profileId: 'default', validationId: validation.validationId, fileName: '../weekly overview.md'
    });
    assert.equal(saved.isError, undefined);
    const savedPayload = saved.structuredContent as { path: string; markdown: string; displayInAgent: boolean };
    const savedPath = savedPayload.path;
    assert.equal(path.dirname(savedPath), path.join(reportDirectory, 'default'));
    assert.equal(path.basename(savedPath), 'weekly-overview.md');
    const contents = await readFile(savedPath, 'utf8');
    assert.match(contents, /# Отчёт по задачам/);
    assert.match(contents, /Просроченные/);
    assert.match(contents, /Исправить критическую ошибку/);
    assert.match(contents, /## Рекомендация/);
    assert.equal(savedPayload.markdown, contents.trim());
    assert.equal(savedPayload.displayInAgent, true);
  } finally {
    await cleanup();
    await rm(reportDirectory, { recursive: true, force: true });
  }
});

test('planner MCP refuses to save a report without a valid server-side validation ID', async () => {
  const { store, cleanup } = await fixture();
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-'));
  try {
    const mcp = new PlannerMcpServer(store, reportDirectory);
    const saved = await mcp.callTool('planner_save_report', {
      profileId: 'default',
      validationId: 'missing-validation'
    });
    assert.equal(saved.isError, true);
    assert.match(saved.content[0].text, /не найден или устарел/i);
  } finally {
    await cleanup();
    await rm(reportDirectory, { recursive: true, force: true });
  }
});

test('completion report closes only a strong match and records an unmatched result without asking', async () => {
  const { store, cleanup } = await fixture();
  try {
    const mcp = new PlannerMcpServer(store);
    store.createTodo({ profileId: 'default', title: 'Забрать заказ на Ozon' });
    const completed = await mcp.callTool('planner_complete_todos', {
      profileId: 'default',
      queries: ['Я забрал заказ на Озон']
    });
    assert.equal(completed.isError, undefined);
    const payload = completed.structuredContent as { completedCount: number; matchedCount: number; addedCount: number };
    assert.equal(payload.completedCount, 1);
    assert.equal(payload.matchedCount, 1);
    assert.equal(payload.addedCount, 0);
    assert.equal(store.listTodos('default').length, 1);
    assert.equal(store.listTodos('default')[0].status, 'completed');

    store.createTodo({ profileId: 'default', title: 'Забрать заказ в Хобби Геймс' });
    const separateResult = await mcp.callTool('planner_complete_todos', {
      profileId: 'default',
      queries: ['Сегодня забрал заказ в Ozon']
    });
    const separatePayload = separateResult.structuredContent as { completedCount: number; matchedCount: number; addedCount: number };
    assert.equal(separatePayload.completedCount, 1);
    assert.equal(separatePayload.matchedCount, 0);
    assert.equal(separatePayload.addedCount, 1);
    const todos = store.listTodos('default');
    assert.equal(todos.length, 3);
    assert.equal(todos.find((todo) => todo.title === 'Забрать заказ в Хобби Геймс')?.status, 'pending');
    assert.equal(todos.find((todo) => todo.title === 'Забрал заказ в Ozon')?.status, 'completed');
  } finally {
    await cleanup();
  }
});

test('planner MCP deletes the todo list and only the requested summary kind', async () => {
  const { store, cleanup } = await fixture();
  try {
    const mcp = new PlannerMcpServer(store);
    store.createTodos('default', [
      { title: 'Купить продукты' },
      { title: 'Забрать заказ' }
    ]);
    store.createDailySummary('default', new Date());
    store.createWeeklySummary('default', new Date());

    const summaryDeletion = await mcp.callTool('planner_delete_summaries', {
      profileId: 'default',
      kind: 'weekly'
    });
    assert.equal(summaryDeletion.isError, undefined);
    assert.equal((summaryDeletion.structuredContent as { deletedCount: number }).deletedCount, 1);
    assert.ok(store.latestSummary('default', 'daily'));
    assert.equal(store.latestSummary('default', 'weekly'), null);

    const todoDeletion = await mcp.callTool('planner_delete_todos', {
      profileId: 'default',
      all: true
    });
    assert.equal(todoDeletion.isError, undefined);
    assert.equal((todoDeletion.structuredContent as { deletedCount: number }).deletedCount, 2);
    assert.equal(store.listTodos('default').length, 0);

    assert.equal(mcp.listTools().find((tool) => tool.name === 'planner_delete_todos')?.annotations?.destructiveHint, true);
    assert.equal(mcp.listTools().find((tool) => tool.name === 'planner_delete_summaries')?.annotations?.destructiveHint, true);
  } finally {
    await cleanup();
  }
});

test('daily summary describes future dates as plans made today, not work due today', async () => {
  const { store, cleanup } = await fixture();
  try {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const dayAfter = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
    store.createTodos('default', [
      { title: 'Купить продукты', dueAt: tomorrow },
      { title: 'Забрать заказ', dueAt: dayAfter }
    ]);
    const summary = store.createDailySummary('default', new Date());
    assert.match(summary.text, /Сегодня запланировано/);
    assert.match(summary.text, /Купить продукты/);
    assert.match(summary.text, /Забрать заказ/);
    const todaySection = summary.text.split('На сегодня\n')[1] ?? '';
    assert.match(todaySection, /Дел со сроком на сегодня нет/);
    assert.doesNotMatch(todaySection, /Купить продукты|Забрать заказ/);
  } finally {
    await cleanup();
  }
});

test('scheduler builds daily and weekly summaries on separate test intervals', async () => {
  const { store, cleanup } = await fixture();
  try {
    store.createTodo({ profileId: 'default', title: 'Проверить сводки' });
    const scheduler = new PlannerScheduler(store);
    const now = new Date('2026-09-28T12:00:00.000Z');
    await scheduler.tick(now);
    assert.equal(TEST_DAILY_SUMMARY_INTERVAL_MS, 60_000);
    assert.equal(TEST_WEEKLY_SUMMARY_INTERVAL_MS, 120_000);
    assert.equal(store.latestSummary('default', 'daily')?.kind, 'daily');
    assert.equal(store.latestSummary('default', 'weekly')?.kind, 'weekly');
  } finally {
    await cleanup();
  }
});

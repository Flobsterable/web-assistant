import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PlannerTodoStatus = 'pending' | 'completed';
export type PlannerPriority = 'low' | 'normal' | 'high';
export type PlannerSummaryKind = 'daily' | 'weekly';

export type PlannerTodo = {
  id: string;
  profileId: string;
  title: string;
  description: string;
  status: PlannerTodoStatus;
  priority: PlannerPriority;
  dueAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type PlannerSummaryMetrics = {
  created: number;
  completed: number;
  pending: number;
  overdue: number;
  completionRate: number;
  byPriority: Record<PlannerPriority, number>;
  meetings: number;
};

export type PlannerCalendarEvent = {
  id: string | null;
  summary: string;
  start: string | null;
  end: string | null;
  location?: string | null;
  url?: string | null;
};

export type PlannerSummary = {
  id: string;
  profileId: string;
  kind: PlannerSummaryKind;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  text: string;
  metrics: PlannerSummaryMetrics;
};

type TodoRow = Record<string, unknown>;
const PLANNER_TIMEZONE = process.env.PLANNER_TIMEZONE?.trim() || 'Asia/Omsk';

function zonedParts(date: Date, timezone = PLANNER_TIMEZONE) {
  const values = new Map(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.get('weekday') ?? ''),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second'))
  };
}

function zonedDateToUtc(year: number, month: number, day: number, timezone = PLANNER_TIMEZONE): Date {
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = zonedParts(new Date(guess), timezone);
    const represented = Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute, current.second);
    guess += desired - represented;
  }
  return new Date(guess);
}

export function plannerSummaryPeriod(kind: PlannerSummaryKind, now: Date) {
  const local = zonedParts(now);
  const daysFromMonday = (local.weekday + 6) % 7;
  const startDate = new Date(Date.UTC(local.year, local.month - 1, local.day - (kind === 'weekly' ? daysFromMonday : 0)));
  const limitDate = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate() + (kind === 'daily' ? 1 : 7)
  ));
  return {
    start: zonedDateToUtc(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, startDate.getUTCDate()),
    limit: zonedDateToUtc(limitDate.getUTCFullYear(), limitDate.getUTCMonth() + 1, limitDate.getUTCDate())
  };
}

function meetingList(events: PlannerCalendarEvent[], empty: string): string {
  if (events.length === 0) return empty;
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: PLANNER_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
  return events.slice(0, 12).map((event) => {
    const when = event.start && !Number.isNaN(Date.parse(event.start)) ? formatter.format(new Date(event.start)) : 'время не указано';
    const where = event.location ? ` · ${event.location}` : '';
    return `• ${when} — ${event.summary}${where}`;
  }).join('\n');
}

function uniqueTodos(...groups: PlannerTodo[][]): PlannerTodo[] {
  return [...new Map(groups.flat().map((todo) => [todo.id, todo])).values()];
}

function todoList(items: PlannerTodo[], empty: string): string {
  return items.length > 0 ? items.slice(0, 7).map((todo) => `• ${todo.title}`).join('\n') : empty;
}

function plannedList(items: PlannerTodo[], empty = '• Сегодня новых дел не запланировано.'): string {
  if (items.length === 0) return empty;
  const groups = new Map<string, string[]>();
  for (const todo of items) {
    const label = todo.dueAt
      ? new Intl.DateTimeFormat('ru-RU', { timeZone: PLANNER_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(todo.dueAt))
      : 'без срока';
    groups.set(label, [...(groups.get(label) ?? []), todo.title]);
  }
  return [...groups].map(([label, titles]) => `• На ${label}: ${titles.join(', ')}.`).join('\n');
}

function searchTokens(value: string): string[] {
  const aliases: Record<string, string> = { озон: 'ozon', озоне: 'ozon', озона: 'ozon' };
  const stopWords = new Set(['я', 'мы', 'он', 'она', 'они', 'уже', 'сегодня', 'вчера', 'на', 'в', 'во', 'с', 'со', 'из', 'и', 'по', 'для', 'это', 'дело', 'задача']);
  return value.toLocaleLowerCase('ru').replaceAll('ё', 'е').match(/[a-zа-я0-9]+/giu)?.map((token) => aliases[token] ?? token)
    .filter((token) => !stopWords.has(token))
    .map((token) => token.replace(/(ться|лись|лась|лся|или|али|яли|ила|ала|яла|ть|ли|ла|л)$/u, ''))
    .filter((token) => token.length > 1) ?? [];
}

function matchScore(query: string, title: string): number {
  const queryTokens = new Set(searchTokens(query));
  const titleTokens = new Set(searchTokens(title));
  if (queryTokens.size === 0 || titleTokens.size === 0) return 0;
  const common = [...queryTokens].filter((token) => titleTokens.has(token)).length;
  return common / Math.max(queryTokens.size, titleTokens.size);
}

function completedTitle(value: string): string {
  const normalized = value.trim()
    .replace(/^(?:(?:сегодня|вчера)\s+)?(?:я\s+)?/iu, '')
    .trim();
  if (!normalized) return value.trim();
  return `${normalized.charAt(0).toLocaleUpperCase('ru')}${normalized.slice(1)}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function calendarEventMarker(eventId: string): string {
  return `Google Calendar event: ${eventId}`;
}

function parseTags(value: unknown): string[] {
  try {
    const parsed = JSON.parse(stringValue(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toTodo(row: TodoRow): PlannerTodo {
  return {
    id: stringValue(row.id),
    profileId: stringValue(row.profile_id),
    title: stringValue(row.title),
    description: stringValue(row.description),
    status: row.status === 'completed' ? 'completed' : 'pending',
    priority: row.priority === 'low' || row.priority === 'high' ? row.priority : 'normal',
    dueAt: nullableString(row.due_at),
    tags: parseTags(row.tags_json),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    completedAt: nullableString(row.completed_at)
  };
}

export class PlannerStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS planner_todos (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
        due_at TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS planner_todos_profile_status ON planner_todos(profile_id, status);
      CREATE INDEX IF NOT EXISTS planner_todos_due_at ON planner_todos(due_at);

      CREATE TABLE IF NOT EXISTS planner_summaries (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'weekly',
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        text TEXT NOT NULL,
        metrics_json TEXT NOT NULL
      );
    `);
    const summaryColumns = this.db.prepare('PRAGMA table_info(planner_summaries)').all() as Array<Record<string, unknown>>;
    if (!summaryColumns.some((column) => column.name === 'kind')) {
      this.db.exec("ALTER TABLE planner_summaries ADD COLUMN kind TEXT NOT NULL DEFAULT 'weekly';");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS planner_summaries_profile_kind ON planner_summaries(profile_id, kind, generated_at DESC);');
  }

  close(): void {
    this.db.close();
  }

  createTodo(input: {
    profileId: string;
    title: string;
    description?: string;
    priority?: PlannerPriority;
    dueAt?: string | null;
    tags?: string[];
  }): PlannerTodo {
    const now = new Date().toISOString();
    const todo: PlannerTodo = {
      id: randomUUID(),
      profileId: input.profileId,
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      status: 'pending',
      priority: input.priority ?? 'normal',
      dueAt: input.dueAt ?? null,
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    this.db.prepare(`INSERT INTO planner_todos
      (id, profile_id, title, description, status, priority, due_at, tags_json, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(todo.id, todo.profileId, todo.title, todo.description, todo.status, todo.priority, todo.dueAt, JSON.stringify(todo.tags), now, now, null);
    return todo;
  }

  createTodos(profileId: string, items: Array<Omit<Parameters<PlannerStore['createTodo']>[0], 'profileId'>>): PlannerTodo[] {
    if (items.length === 0) throw new Error('Список дел пуст.');
    if (items.length > 50) throw new Error('За один вызов можно сохранить не более 50 дел.');
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const todos = items.map((item) => this.createTodo({ ...item, profileId }));
      this.db.exec('COMMIT;');
      return todos;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  listTodos(profileId: string, status?: PlannerTodoStatus): PlannerTodo[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM planner_todos WHERE profile_id = ? AND status = ? ORDER BY status, due_at IS NULL, due_at, created_at DESC').all(profileId, status)
      : this.db.prepare('SELECT * FROM planner_todos WHERE profile_id = ? ORDER BY status, due_at IS NULL, due_at, created_at DESC').all(profileId);
    return rows.map((row) => toTodo(row as TodoRow));
  }

  syncCalendarEvents(profileId: string, events: PlannerCalendarEvent[]): {
    created: PlannerTodo[];
    updated: PlannerTodo[];
    unchanged: PlannerTodo[];
    skippedWithoutId: number;
  } {
    const created: PlannerTodo[] = [];
    const updated: PlannerTodo[] = [];
    const unchanged: PlannerTodo[] = [];
    let skippedWithoutId = 0;
    for (const event of events) {
      if (!event.id) {
        skippedWithoutId += 1;
        continue;
      }
      const marker = calendarEventMarker(event.id);
      const existing = this.listTodos(profileId).find((todo) => todo.description.split(/\r?\n/u).includes(marker));
      if (!existing) {
        const description = [marker, event.url, event.location ? `Место: ${event.location}` : null]
          .filter((line): line is string => Boolean(line))
          .join('\n');
        created.push(this.createTodo({
          profileId,
          title: event.summary,
          description,
          dueAt: event.start,
          tags: ['calendar']
        }));
        continue;
      }
      const nextTags = [...new Set([...existing.tags, 'calendar'])];
      if (existing.title !== event.summary || existing.dueAt !== event.start || !existing.tags.includes('calendar')) {
        const todo = this.updateTodo(profileId, existing.id, {
          title: event.summary,
          dueAt: event.start,
          tags: nextTags
        });
        if (todo) updated.push(todo);
      } else {
        unchanged.push(existing);
      }
    }
    return { created, updated, unchanged, skippedWithoutId };
  }

  getTodo(profileId: string, id: string): PlannerTodo | null {
    const row = this.db.prepare('SELECT * FROM planner_todos WHERE profile_id = ? AND id = ?').get(profileId, id);
    return row ? toTodo(row as TodoRow) : null;
  }

  updateTodo(profileId: string, id: string, patch: {
    title?: string;
    description?: string;
    status?: PlannerTodoStatus;
    priority?: PlannerPriority;
    dueAt?: string | null;
    tags?: string[];
  }): PlannerTodo | null {
    const current = this.getTodo(profileId, id);
    if (!current) return null;
    const now = new Date().toISOString();
    const status = patch.status ?? current.status;
    const next: PlannerTodo = {
      ...current,
      title: patch.title?.trim() || current.title,
      description: patch.description === undefined ? current.description : patch.description.trim(),
      status,
      priority: patch.priority ?? current.priority,
      dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
      tags: patch.tags === undefined ? current.tags : [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
      updatedAt: now,
      completedAt: status === 'completed' ? current.completedAt ?? now : null
    };
    this.db.prepare(`UPDATE planner_todos SET title = ?, description = ?, status = ?, priority = ?, due_at = ?,
      tags_json = ?, updated_at = ?, completed_at = ? WHERE profile_id = ? AND id = ?`)
      .run(next.title, next.description, next.status, next.priority, next.dueAt, JSON.stringify(next.tags), now, next.completedAt, profileId, id);
    return next;
  }

  completeTodosByQuery(profileId: string, queries: string[]): {
    completed: PlannerTodo[];
    matched: PlannerTodo[];
    added: PlannerTodo[];
  } {
    if (queries.length === 0) throw new Error('Список выполненных дел пуст.');
    if (queries.length > 50) throw new Error('За один вызов можно завершить не более 50 дел.');
    const available = this.listTodos(profileId, 'pending');
    const completed: PlannerTodo[] = [];
    const matched: PlannerTodo[] = [];
    const added: PlannerTodo[] = [];

    for (const rawQuery of queries) {
      const query = rawQuery.trim();
      if (!query) continue;
      const ranked = available
        .filter((todo) => !matched.some((item) => item.id === todo.id))
        .map((todo) => ({ todo, score: matchScore(query, todo.title) }))
        .filter((candidate) => candidate.score >= 0.65)
        .sort((left, right) => right.score - left.score);
      if (ranked.length === 1 || (ranked.length > 1 && ranked[0].score - ranked[1].score >= 0.15)) {
        const updated = this.updateTodo(profileId, ranked[0].todo.id, { status: 'completed' });
        if (updated) {
          matched.push(updated);
          completed.push(updated);
          continue;
        }
      }
      const created = this.createTodo({ profileId, title: completedTitle(query) });
      const recorded = this.updateTodo(profileId, created.id, { status: 'completed' });
      if (recorded) {
        added.push(recorded);
        completed.push(recorded);
      }
    }
    return { completed, matched, added };
  }

  deleteTodos(profileId: string, input: { all?: boolean; ids?: string[]; queries?: string[] }): {
    deleted: PlannerTodo[];
    notFound: string[];
    ambiguous: Array<{ query: string; candidates: Array<{ id: string; title: string }> }>;
  } {
    const todos = this.listTodos(profileId);
    if (input.all === true) {
      this.db.prepare('DELETE FROM planner_todos WHERE profile_id = ?').run(profileId);
      return { deleted: todos, notFound: [], ambiguous: [] };
    }
    const deleted: PlannerTodo[] = [];
    const notFound: string[] = [];
    const ambiguous: Array<{ query: string; candidates: Array<{ id: string; title: string }> }> = [];
    const ids = [...new Set((input.ids ?? []).map((id) => id.trim()).filter(Boolean))];
    const queries = input.queries ?? [];
    if (ids.length === 0 && queries.length === 0) throw new Error('Укажите ids, queries или all=true.');
    if (ids.length > 50 || queries.length > 50) throw new Error('За один вызов можно удалить не более 50 дел.');
    for (const id of ids) {
      const todo = todos.find((item) => item.id === id);
      if (!todo || !this.deleteTodo(profileId, id)) notFound.push(id);
      else deleted.push(todo);
    }
    for (const rawQuery of queries) {
      const query = rawQuery.trim();
      if (!query) continue;
      const ranked = todos
        .filter((todo) => !deleted.some((item) => item.id === todo.id))
        .map((todo) => ({ todo, score: matchScore(query, todo.title) }))
        .filter((candidate) => candidate.score >= 0.45)
        .sort((left, right) => right.score - left.score);
      if (ranked.length === 0) {
        notFound.push(query);
      } else if (ranked.length > 1 && ranked[0].score - ranked[1].score < 0.15) {
        ambiguous.push({ query, candidates: ranked.slice(0, 3).map(({ todo }) => ({ id: todo.id, title: todo.title })) });
      } else if (this.deleteTodo(profileId, ranked[0].todo.id)) {
        deleted.push(ranked[0].todo);
      }
    }
    return { deleted, notFound, ambiguous };
  }

  deleteSummaries(profileId: string, kind: PlannerSummaryKind | 'all'): number {
    const result = kind === 'all'
      ? this.db.prepare('DELETE FROM planner_summaries WHERE profile_id = ?').run(profileId)
      : this.db.prepare('DELETE FROM planner_summaries WHERE profile_id = ? AND kind = ?').run(profileId, kind);
    return Number(result.changes);
  }

  deleteTodo(profileId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM planner_todos WHERE profile_id = ? AND id = ?').run(profileId, id).changes) > 0;
  }

  listProfileIds(): string[] {
    const rows = this.db.prepare(`
      SELECT profile_id FROM planner_todos
      UNION SELECT profile_id FROM planner_summaries
    `).all() as Array<Record<string, unknown>>;
    const values = rows.map((row) => stringValue(row.profile_id)).filter(Boolean);
    return values.length > 0 ? values : ['default'];
  }

  createSummary(
    profileId: string,
    kind: PlannerSummaryKind,
    periodEnd = new Date(),
    calendarEvents: PlannerCalendarEvent[] = []
  ): PlannerSummary {
    const end = periodEnd.toISOString();
    const period = plannerSummaryPeriod(kind, periodEnd);
    const start = period.start.toISOString();
    const limit = period.limit.toISOString();
    const todos = this.listTodos(profileId);
    const createdTodos = todos.filter((todo) => todo.createdAt >= start && todo.createdAt <= end);
    const completedTodos = todos.filter((todo) => todo.completedAt && todo.completedAt >= start && todo.completedAt <= end);
    const dueInPeriod = todos.filter((todo) => todo.dueAt && todo.dueAt >= start && todo.dueAt < limit);
    const relevantTodos = uniqueTodos(createdTodos, completedTodos, dueInPeriod);
    const created = createdTodos.length;
    const completed = completedTodos.length;
    const pendingTodos = relevantTodos.filter((todo) => todo.status === 'pending');
    const overdue = pendingTodos.filter((todo) => todo.dueAt && todo.dueAt < end).length;
    const byPriority: Record<PlannerPriority, number> = { low: 0, normal: 0, high: 0 };
    for (const todo of pendingTodos) byPriority[todo.priority] += 1;
    const metrics: PlannerSummaryMetrics = {
      created,
      completed,
      pending: pendingTodos.length,
      overdue,
      completionRate: created === 0 ? (completed > 0 ? 100 : 0) : Math.min(100, Math.round((completed / created) * 100)),
      byPriority,
      meetings: calendarEvents.length
    };
    const text = kind === 'daily'
      ? [
        `Сегодня добавлено дел: ${created}, выполнено: ${completed}.`,
        `Сегодня запланировано\n${plannedList(createdTodos)}`,
        `Выполнено сегодня\n${todoList(completedTodos, '• Сегодня завершённых дел нет.')}`,
        `На сегодня\n${todoList(dueInPeriod.filter((todo) => todo.status === 'pending'), '• Дел со сроком на сегодня нет.')}`,
        `Встречи в календаре\n${meetingList(calendarEvents, '• Встреч на сегодня нет.')}`
      ].join('\n\n')
      : [
        `На текущей неделе добавлено дел: ${created}, выполнено: ${completed}.`,
        `Сделано за неделю\n${todoList(completedTodos, '• На этой неделе завершённых дел нет.')}`,
        `Запланировано за неделю\n${plannedList(createdTodos, '• На этой неделе новых дел не запланировано.')}`,
        `Встречи недели\n${meetingList(calendarEvents, '• Встреч на этой неделе нет.')}`,
        `Остаётся по делам недели\n${todoList(pendingTodos, '• Остальных дел на этой неделе нет.')}`,
        overdue > 0 ? `Требует внимания\n• Просрочено дел недели: ${overdue}.` : 'Требует внимания\n• Просроченных дел недели нет.'
      ].join('\n\n');
    const summary: PlannerSummary = {
      id: randomUUID(), profileId, kind, periodStart: start, periodEnd: end,
      generatedAt: new Date().toISOString(), text, metrics
    };
    this.db.prepare(`INSERT INTO planner_summaries
      (id, profile_id, kind, period_start, period_end, generated_at, text, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(summary.id, profileId, kind, start, end, summary.generatedAt, text, JSON.stringify(metrics));
    return summary;
  }

  createDailySummary(profileId: string, periodEnd = new Date(), calendarEvents: PlannerCalendarEvent[] = []): PlannerSummary {
    return this.createSummary(profileId, 'daily', periodEnd, calendarEvents);
  }

  createWeeklySummary(profileId: string, periodEnd = new Date(), calendarEvents: PlannerCalendarEvent[] = []): PlannerSummary {
    return this.createSummary(profileId, 'weekly', periodEnd, calendarEvents);
  }

  latestSummary(profileId: string, kind: PlannerSummaryKind = 'weekly'): PlannerSummary | null {
    const row = this.db.prepare('SELECT * FROM planner_summaries WHERE profile_id = ? AND kind = ? ORDER BY generated_at DESC LIMIT 1').get(profileId, kind) as TodoRow | undefined;
    if (!row) return null;
    return {
      id: stringValue(row.id), profileId: stringValue(row.profile_id), kind: row.kind === 'daily' ? 'daily' : 'weekly', periodStart: stringValue(row.period_start),
      periodEnd: stringValue(row.period_end), generatedAt: stringValue(row.generated_at), text: stringValue(row.text),
      metrics: JSON.parse(stringValue(row.metrics_json)) as PlannerSummaryMetrics
    };
  }
}

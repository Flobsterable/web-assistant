import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { McpToolDefinition, McpToolResult } from '../mcp/google-calendar-mcp.js';
import type { PlannerPriority, PlannerStore, PlannerTodo, PlannerTodoStatus } from './planner-store.js';

type ToolDefinition = McpToolDefinition & {
  title?: string;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
};

type PlannerReport = {
  title: string;
  generatedAt: string;
  markdown: string;
  todoCount: number;
  sourceTodoIds: string[];
  metrics: {
    pending: number;
    completed: number;
    overdue: number;
    highPriority: number;
  };
};

type PlannerReportValidation = {
  valid: boolean;
  checkedAt: string;
  issues: string[];
  report: PlannerReport;
};

const tools: ToolDefinition[] = [
  {
    name: 'planner_save_todos',
    title: 'Сохранить список дел',
    description: 'Сохраняет одно или несколько дел пользователя. Используй, когда пользователь перечисляет список дел или просит добавить новое дело.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['todos'],
      properties: {
        profileId: { type: 'string', description: 'Профиль пользователя; обычно добавляется клиентом.' },
        todos: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object', additionalProperties: false, required: ['title'],
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 300 },
              description: { type: 'string', maxLength: 4000 },
              priority: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal' },
              dueAt: { type: ['string', 'null'], format: 'date-time', description: 'Срок в RFC 3339.' }
            }
          }
        }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'planner_list_todos',
    title: 'Показать дела',
    description: 'Возвращает сохранённые дела пользователя и их сроки. Используй для вопросов о списке дел, просроченных или завершённых задачах.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        profileId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'completed'] }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'planner_complete_todos',
    title: 'Записать выполненные дела',
    description: 'Записывает факт выполненного дела для дневной и недельной сводки. Если подходящее активное дело найдено по смыслу, закрывает его. Если совпадения нет или оно неоднозначно, сразу создаёт отдельную выполненную запись. Используй, когда пользователь сообщает о результате в прошедшем времени: «сделал», «забрал», «купил», «отправил», «уже готово». Не проси подтверждения.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['queries'],
      properties: {
        profileId: { type: 'string' },
        queries: {
          type: 'array', minItems: 1, maxItems: 50,
          description: 'Короткие названия выполненных дел из сообщения пользователя.',
          items: { type: 'string', minLength: 1, maxLength: 300 }
        }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'planner_update_todo',
    title: 'Обновить дело',
    description: 'Изменяет сохранённое дело или отмечает его выполненным. Сначала получи ID через planner_list_todos, если он неизвестен.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        profileId: { type: 'string' }, id: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 300 },
        description: { type: 'string', maxLength: 4000 }, status: { type: 'string', enum: ['pending', 'completed'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] }, dueAt: { type: ['string', 'null'], format: 'date-time' },
        tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 50 } }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'planner_delete_todos',
    title: 'Удалить дела',
    description: 'Удаляет отдельные дела по смысловому названию или полностью очищает список. Используй только когда пользователь явно просит удалить дело или очистить список. Для «очисти список дел» передай all=true.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        profileId: { type: 'string' },
        all: { type: 'boolean', description: 'Удалить весь список дел.' },
        queries: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 300 } }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: 'planner_delete_summaries',
    title: 'Удалить сводки',
    description: 'Удаляет сохранённую дневную, недельную или все сводки. Используй только по явной просьбе пользователя. Фоновый worker создаст новую сводку при следующем запуске.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['kind'],
      properties: {
        profileId: { type: 'string' },
        kind: { type: 'string', enum: ['daily', 'weekly', 'all'] }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: 'planner_get_summaries',
    title: 'Получить сводки',
    description: 'Возвращает последние фоновые сводки за день и за неделю.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { profileId: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'planner_build_report',
    title: 'Сформировать отчёт по делам',
    description: 'Преобразует результат planner_list_todos в серверный черновик Markdown-отчёта со статистикой, просрочками и рекомендацией. Передай todos без изменений из результата предыдущего инструмента. Инструмент вернёт reportId; затем обязательно передай только этот reportId в planner_validate_report.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['todos'],
      properties: {
        profileId: { type: 'string' },
        title: { type: 'string', maxLength: 120 },
        todos: { type: 'array', maxItems: 100, items: { type: 'object' } }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'planner_validate_report',
    title: 'Проверить отчёт',
    description: 'Проверяет структуру и полноту серверного черновика. Передай reportId из planner_build_report. Инструмент вернёт validationId; если valid=true, передай только validationId в planner_save_report.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['reportId'],
      properties: { profileId: { type: 'string' }, reportId: { type: 'string' } }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'planner_save_report',
    title: 'Сохранить проверенный отчёт',
    description: 'Сохраняет проверенный Markdown-отчёт в каталог reports. Вызывай только после planner_validate_report и передавай validationId из его результата. Непрошедший проверку отчёт не сохраняется.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['validationId'],
      properties: {
        profileId: { type: 'string' },
        fileName: { type: 'string', maxLength: 120 },
        validationId: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }
];

function result(payload: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  };
}

function recordArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function text(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name} обязателен.`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} должен быть непустой строкой.`);
  return value.trim();
}

function profileId(input: Record<string, unknown>): string {
  return text(input.profileId, 'profileId') ?? 'default';
}

function dueAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('dueAt должен быть датой RFC 3339.');
  return new Date(value).toISOString();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`Некорректное значение ${name}.`);
  return value as T;
}

function tags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('tags должен быть массивом строк.');
  return value as string[];
}

function reportTodo(value: unknown, index: number): PlannerTodo {
  const item = recordArgs(value);
  const status = enumValue(item.status, ['pending', 'completed'] as const, `todos[${index}].status`);
  const priority = enumValue(item.priority, ['low', 'normal', 'high'] as const, `todos[${index}].priority`);
  return {
    id: text(item.id, `todos[${index}].id`, true) as string,
    profileId: typeof item.profileId === 'string' ? item.profileId : '',
    title: text(item.title, `todos[${index}].title`, true) as string,
    description: typeof item.description === 'string' ? item.description : '',
    status: status ?? 'pending',
    priority: priority ?? 'normal',
    dueAt: dueAt(item.dueAt) ?? null,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    completedAt: typeof item.completedAt === 'string' ? item.completedAt : null
  };
}

function inlineMarkdown(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}[\]()#+.!|>-])/g, '\\$1').trim();
}

function taskLine(todo: PlannerTodo): string {
  const due = todo.dueAt
    ? ` — до ${new Intl.DateTimeFormat('ru-RU', { timeZone: process.env.PLANNER_TIMEZONE?.trim() || 'Asia/Omsk', dateStyle: 'medium' }).format(new Date(todo.dueAt))}`
    : '';
  const tagsText = todo.tags.length > 0 ? ` · ${todo.tags.map((tag) => `#${inlineMarkdown(tag)}`).join(' ')}` : '';
  return `- ${inlineMarkdown(todo.title)}${due}${tagsText}`;
}

function reportSection(title: string, todos: PlannerTodo[], emptyText: string): string {
  return [`## ${title}`, todos.length > 0 ? todos.map(taskLine).join('\n') : emptyText].join('\n\n');
}

function buildReport(todos: PlannerTodo[], requestedTitle?: string): PlannerReport {
  const generatedAt = new Date();
  const pending = todos.filter((todo) => todo.status === 'pending');
  const completed = todos.filter((todo) => todo.status === 'completed');
  const overdue = pending.filter((todo) => todo.dueAt && new Date(todo.dueAt).getTime() < generatedAt.getTime());
  const highPriority = pending.filter((todo) => todo.priority === 'high');
  const title = requestedTitle?.trim() || 'Отчёт по задачам';
  const recommendation = overdue.length > 0
    ? `Начните с просроченных задач: ${overdue.slice(0, 3).map((todo) => inlineMarkdown(todo.title)).join(', ')}.`
    : highPriority.length > 0
      ? `Следующий фокус: ${inlineMarkdown(highPriority[0].title)}.`
      : pending.length > 0
        ? `Следующий фокус: ${inlineMarkdown(pending[0].title)}.`
        : 'Активных задач нет — список можно пополнить новым делом.';
  const markdown = [
    `# ${inlineMarkdown(title)}`,
    `Дата формирования: ${new Intl.DateTimeFormat('ru-RU', { timeZone: process.env.PLANNER_TIMEZONE?.trim() || 'Asia/Omsk', dateStyle: 'long', timeStyle: 'short' }).format(generatedAt)}`,
    '## Статистика',
    [`- Всего задач: ${todos.length}`, `- Незавершённых: ${pending.length}`, `- Выполненных: ${completed.length}`, `- Просроченных: ${overdue.length}`, `- Высокого приоритета: ${highPriority.length}`].join('\n'),
    reportSection('Просроченные', overdue, 'Просроченных задач нет.'),
    reportSection('Высокий приоритет', highPriority, 'Срочных задач нет.'),
    reportSection('Остальные незавершённые', pending.filter((todo) => todo.priority !== 'high' && !overdue.some((item) => item.id === todo.id)), 'Других незавершённых задач нет.'),
    reportSection('Выполненные', completed, 'Выполненных задач в выборке нет.'),
    ['## Рекомендация', recommendation].join('\n\n'),
    `<!-- planner-report:v1;items=${todos.length} -->`
  ].join('\n\n');
  return {
    title,
    generatedAt: generatedAt.toISOString(),
    markdown,
    todoCount: todos.length,
    sourceTodoIds: todos.map((todo) => todo.id),
    metrics: { pending: pending.length, completed: completed.length, overdue: overdue.length, highPriority: highPriority.length }
  };
}

function validateReport(candidate: PlannerReport): PlannerReportValidation {
  const issues: string[] = [];
  if (!candidate.markdown.startsWith('# ')) issues.push('Отсутствует заголовок первого уровня.');
  for (const heading of ['## Статистика', '## Просроченные', '## Высокий приоритет', '## Рекомендация']) {
    if (!candidate.markdown.includes(heading)) issues.push(`Отсутствует раздел «${heading.slice(3)}».`);
  }
  if (!candidate.markdown.includes(`<!-- planner-report:v1;items=${candidate.todoCount} -->`)) issues.push('Не совпадает контрольное количество задач.');
  if (candidate.sourceTodoIds.length !== candidate.todoCount) issues.push('Количество исходных ID не совпадает с количеством задач.');
  if (new Set(candidate.sourceTodoIds).size !== candidate.sourceTodoIds.length) issues.push('В исходных ID есть дубликаты.');
  if (candidate.metrics.pending + candidate.metrics.completed !== candidate.todoCount) issues.push('Статистика статусов не сходится с общим количеством задач.');
  if (candidate.metrics.overdue > candidate.metrics.pending) issues.push('Просроченных задач больше, чем незавершённых.');
  if (candidate.metrics.highPriority > candidate.metrics.pending) issues.push('Приоритетных задач больше, чем незавершённых.');
  return { valid: issues.length === 0, checkedAt: new Date().toISOString(), issues, report: candidate };
}

function safePathPart(value: string, fallback: string): string {
  const safe = value.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return safe || fallback;
}

export class PlannerMcpServer {
  private readonly reportDrafts = new Map<string, { profileId: string; createdAt: number; report: PlannerReport }>();
  private readonly reportValidations = new Map<string, { profileId: string; createdAt: number; validation: PlannerReportValidation }>();

  constructor(
    private readonly store: PlannerStore,
    private readonly reportDirectory = path.resolve(process.cwd(), 'server/data/reports')
  ) {}

  listTools(): ToolDefinition[] {
    return tools;
  }

  private cleanupReportPipeline(): void {
    const expiresBefore = Date.now() - 15 * 60_000;
    for (const [id, draft] of this.reportDrafts) if (draft.createdAt < expiresBefore) this.reportDrafts.delete(id);
    for (const [id, validation] of this.reportValidations) if (validation.createdAt < expiresBefore) this.reportValidations.delete(id);
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    try {
      const input = recordArgs(args);
      const owner = profileId(input);
      if (name === 'planner_save_todos') {
        if (!Array.isArray(input.todos)) throw new Error('todos должен быть непустым массивом дел.');
        const items = input.todos.map((value, index) => {
          const item = recordArgs(value);
          return {
            title: text(item.title, `todos[${index}].title`, true) as string,
            description: text(item.description, `todos[${index}].description`),
            priority: enumValue(item.priority, ['low', 'normal', 'high'] as const, `todos[${index}].priority`) as PlannerPriority | undefined,
            dueAt: dueAt(item.dueAt)
          };
        });
        const todos = this.store.createTodos(owner, items);
        return result({ count: todos.length, todos });
      }
      if (name === 'planner_list_todos') {
        const status = enumValue(input.status, ['pending', 'completed'] as const, 'status') as PlannerTodoStatus | undefined;
        const todos = this.store.listTodos(owner, status);
        return result({ count: todos.length, todos });
      }
      if (name === 'planner_complete_todos') {
        if (!Array.isArray(input.queries) || input.queries.some((query) => typeof query !== 'string')) {
          throw new Error('queries должен быть непустым массивом строк.');
        }
        const completion = this.store.completeTodosByQuery(owner, input.queries as string[]);
        return result({
          completedCount: completion.completed.length,
          matchedCount: completion.matched.length,
          addedCount: completion.added.length,
          ...completion,
          message: `Записано выполненных дел: ${completion.completed.length}. Уточнение не требуется.`
        });
      }
      if (name === 'planner_update_todo') {
        const id = text(input.id, 'id', true) as string;
        const todo = this.store.updateTodo(owner, id, {
          title: text(input.title, 'title'), description: input.description === '' ? '' : text(input.description, 'description'),
          status: enumValue(input.status, ['pending', 'completed'] as const, 'status') as PlannerTodoStatus | undefined,
          priority: enumValue(input.priority, ['low', 'normal', 'high'] as const, 'priority') as PlannerPriority | undefined,
          dueAt: dueAt(input.dueAt), tags: tags(input.tags)
        });
        return todo ? result({ todo }) : result({ error: 'Дело не найдено.' }, true);
      }
      if (name === 'planner_delete_todos') {
        const queries = input.queries === undefined
          ? undefined
          : Array.isArray(input.queries) && input.queries.every((query) => typeof query === 'string')
            ? input.queries as string[]
            : (() => { throw new Error('queries должен быть массивом строк.'); })();
        const deletion = this.store.deleteTodos(owner, { all: input.all === true, queries });
        return result({ deletedCount: deletion.deleted.length, ...deletion });
      }
      if (name === 'planner_delete_summaries') {
        const kind = enumValue(input.kind, ['daily', 'weekly', 'all'] as const, 'kind');
        if (!kind) throw new Error('kind обязателен.');
        const deletedCount = this.store.deleteSummaries(owner, kind);
        return result({ kind, deletedCount, message: 'Сводки удалены. Новая сводка появится после следующего фонового запуска.' });
      }
      if (name === 'planner_get_summaries') {
        return result({ daily: this.store.latestSummary(owner, 'daily'), weekly: this.store.latestSummary(owner, 'weekly') });
      }
      if (name === 'planner_build_report') {
        if (!Array.isArray(input.todos)) throw new Error('todos должен быть массивом из результата planner_list_todos.');
        const built = buildReport(input.todos.map(reportTodo), text(input.title, 'title'));
        this.cleanupReportPipeline();
        const reportId = randomUUID();
        this.reportDrafts.set(reportId, { profileId: owner, createdAt: Date.now(), report: built });
        const date = built.generatedAt.slice(0, 10);
        return result({ reportId, todoCount: built.todoCount, metrics: built.metrics, suggestedFileName: `todos-${date}.md` });
      }
      if (name === 'planner_validate_report') {
        this.cleanupReportPipeline();
        const reportId = text(input.reportId, 'reportId', true) as string;
        const draft = this.reportDrafts.get(reportId);
        if (!draft || draft.profileId !== owner) throw new Error('Черновик отчёта не найден или устарел. Сначала снова вызовите planner_build_report.');
        const validation = validateReport(draft.report);
        const validationId = randomUUID();
        this.reportValidations.set(validationId, { profileId: owner, createdAt: Date.now(), validation });
        return result({
          validationId,
          reportId,
          valid: validation.valid,
          checkedAt: validation.checkedAt,
          issues: validation.issues,
          todoCount: validation.report.todoCount,
          metrics: validation.report.metrics
        });
      }
      if (name === 'planner_save_report') {
        this.cleanupReportPipeline();
        const validationId = text(input.validationId, 'validationId', true) as string;
        const storedValidation = this.reportValidations.get(validationId);
        if (!storedValidation || storedValidation.profileId !== owner) throw new Error('Проверенный отчёт не найден или устарел. Сначала снова выполните построение и проверку отчёта.');
        const validation = storedValidation.validation;
        const currentValidation = validateReport(validation.report);
        const issues = [...new Set([...validation.issues, ...currentValidation.issues])];
        if (!validation.valid || !currentValidation.valid || issues.length > 0) throw new Error(`Отчёт не прошёл проверку: ${issues.join(' ') || 'неизвестная ошибка'}`);
        const profileDirectory = path.join(this.reportDirectory, safePathPart(owner, 'default'));
        await mkdir(profileDirectory, { recursive: true });
        const requestedName = text(input.fileName, 'fileName') ?? `todos-${validation.report.generatedAt.slice(0, 10)}.md`;
        const extensionlessName = requestedName.toLocaleLowerCase().endsWith('.md') ? requestedName.slice(0, -3) : requestedName;
        const baseName = safePathPart(path.basename(extensionlessName), 'todos-report');
        let filePath = path.join(profileDirectory, `${baseName}.md`);
        for (let suffix = 2; suffix < 1000; suffix += 1) {
          try {
            const savedMarkdown = validation.report.markdown.trim();
            await writeFile(filePath, `${savedMarkdown}\n`, { encoding: 'utf8', flag: 'wx' });
            this.reportValidations.delete(validationId);
            return result({
              saved: true,
              path: filePath,
              fileName: path.basename(filePath),
              bytes: Buffer.byteLength(`${savedMarkdown}\n`),
              markdown: savedMarkdown,
              displayInAgent: true
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            filePath = path.join(profileDirectory, `${baseName}-${suffix}.md`);
          }
        }
        throw new Error('Не удалось подобрать свободное имя файла отчёта.');
      }
      return result({ error: `Unknown tool: ${name}` }, true);
    } catch (error) {
      return result({ error: error instanceof Error ? error.message : 'Ошибка Planner.' }, true);
    }
  }

  async handleHttp(req: Request, res: Response): Promise<Response | void> {
    const message = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const id = message.id as string | number | null | undefined;
    const method = typeof message.method === 'string' ? message.method : '';
    if (method === 'notifications/initialized') return res.status(202).send();
    if (id === undefined) return res.status(202).send();
    const respond = (payload: unknown) => res.json({ jsonrpc: '2.0', id, result: payload });
    if (method === 'initialize') {
      const params = recordArgs(message.params);
      return respond({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'planner-mcp', version: '1.0.0' },
        instructions: 'Use planner_save_todos for future commitments and planner_complete_todos for any completed work. A completion is always recorded without asking: close a strong matching pending todo, otherwise add a separate completed entry. Explicit deletion requests use planner_delete_todos or planner_delete_summaries; never substitute another tool.'
      });
    }
    if (method === 'tools/list') return respond({ tools: this.listTools() });
    if (method === 'tools/call') {
      const params = recordArgs(message.params);
      return respond(await this.callTool(String(params.name ?? ''), params.arguments));
    }
    return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

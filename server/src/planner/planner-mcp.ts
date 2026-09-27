import type { Request, Response } from 'express';
import type { McpToolDefinition, McpToolResult } from '../mcp/google-calendar-mcp.js';
import type { PlannerPriority, PlannerStore, PlannerTodoStatus } from './planner-store.js';

type ToolDefinition = McpToolDefinition & {
  title?: string;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
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

export class PlannerMcpServer {
  constructor(private readonly store: PlannerStore) {}

  listTools(): ToolDefinition[] {
    return tools;
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

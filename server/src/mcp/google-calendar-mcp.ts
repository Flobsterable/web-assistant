import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';

const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const DEFAULT_CALENDAR_TIME_ZONE = process.env.PLANNER_TIMEZONE?.trim() || 'Asia/Omsk';

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

type GoogleOAuthToken = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
};

type CalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
};

type CalendarEventsResponse = {
  summary?: string;
  timeZone?: string;
  items?: CalendarEvent[];
  error?: { message?: string };
};

const listEventsTool: McpToolDefinition = {
  name: 'google_calendar_list_events',
  description: 'Возвращает события из Google Calendar пользователя за указанный период. Используй для вопросов о расписании, встречах и свободном времени.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      calendarId: {
        type: 'string',
        description: "ID календаря; по умолчанию 'primary'."
      },
      timeMin: {
        type: 'string',
        format: 'date-time',
        description: 'Начало периода включительно в RFC 3339; по умолчанию текущее время.'
      },
      timeMax: {
        type: 'string',
        format: 'date-time',
        description: 'Конец периода исключительно в RFC 3339.'
      },
      query: {
        type: 'string',
        description: 'Необязательный полнотекстовый поиск по событиям.'
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Максимальное число событий.'
      }
    }
  }
};

const createEventTool: McpToolDefinition = {
  name: 'google_calendar_create_event',
  description: 'Создаёт встречу в Google Calendar. Используй для явно запланированной встречи, затем обязательно создай связанное дело через planner_save_todos со сроком, равным началу встречи.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'start', 'end'],
    properties: {
      calendarId: { type: 'string', description: "ID календаря; по умолчанию 'primary'." },
      summary: { type: 'string', minLength: 1, maxLength: 300, description: 'Название встречи.' },
      description: { type: 'string', maxLength: 4000 },
      location: { type: 'string', maxLength: 500 },
      start: { type: 'string', format: 'date-time', description: 'Начало встречи в RFC 3339.' },
      end: { type: 'string', format: 'date-time', description: 'Конец встречи в RFC 3339; должен быть позже начала.' },
      timeZone: { type: 'string', default: DEFAULT_CALENDAR_TIME_ZONE, description: `IANA timezone. По умолчанию локальный пояс пользователя: ${DEFAULT_CALENDAR_TIME_ZONE}.` },
      attendees: {
        type: 'array', maxItems: 50, description: 'Email участников.',
        items: { type: 'string', format: 'email' }
      },
      sendUpdates: { type: 'string', enum: ['all', 'externalOnly', 'none'], default: 'all' }
    }
  }
};

const deleteEventTool: McpToolDefinition = {
  name: 'google_calendar_delete_event',
  description: 'Удаляет одно событие Google Calendar по точному eventId. Перед удалением получи eventId через google_calendar_list_events и убедись, что найдено ровно нужное событие.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['eventId'],
    properties: {
      calendarId: { type: 'string', description: "ID календаря; по умолчанию 'primary'." },
      eventId: { type: 'string', minLength: 1, maxLength: 1024, description: 'Точный ID из google_calendar_list_events.' },
      sendUpdates: { type: 'string', enum: ['all', 'externalOnly', 'none'], default: 'all' }
    }
  }
};

function requireString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalDateTime(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} должен быть датой и временем в формате RFC 3339.`);
  }
  return new Date(value).toISOString();
}

function normalizeMaxResults(value: unknown): number {
  if (value === undefined) return 10;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('maxResults должен быть целым числом от 1 до 50.');
  }
  return value;
}

function limitedText(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function textResult(payload: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  };
}

export class GoogleCalendarAuth {
  private readonly pendingStates = new Map<string, number>();

  constructor(
    private readonly tokenFilePath: string,
    private readonly clientId: string | null,
    private readonly clientSecret: string | null,
    private readonly redirectUri: string
  ) {}

  configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  async status(): Promise<{ configured: boolean; connected: boolean; scope: string | null; redirectUri: string }> {
    const token = await this.readToken();
    return {
      configured: this.configured(),
      connected: Boolean(token?.access_token || token?.refresh_token),
      scope: token?.scope ?? null,
      redirectUri: this.redirectUri
    };
  }

  createAuthorizationUrl(): string {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Добавьте GOOGLE_CALENDAR_CLIENT_ID и GOOGLE_CALENDAR_CLIENT_SECRET в .env.');
    }
    const state = randomUUID();
    const now = Date.now();
    for (const [key, expiresAt] of this.pendingStates) {
      if (expiresAt <= now) this.pendingStates.delete(key);
    }
    this.pendingStates.set(state, now + 10 * 60_000);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: CALENDAR_EVENTS_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state
    }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string, state: string): Promise<void> {
    const expiresAt = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!expiresAt || expiresAt <= Date.now()) throw new Error('OAuth state недействителен или истёк. Начните подключение заново.');
    if (!this.clientId || !this.clientSecret) throw new Error('Google OAuth не настроен.');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw new Error(typeof payload.error_description === 'string' ? payload.error_description : 'Google не выдал OAuth token.');
    }
    await this.saveToken({
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
      expires_at: Date.now() + (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) * 1000,
      scope: typeof payload.scope === 'string' ? payload.scope : CALENDAR_EVENTS_SCOPE,
      token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer'
    });
  }

  async disconnect(): Promise<void> {
    const token = await this.readToken();
    const revokeToken = token?.refresh_token ?? token?.access_token;
    if (revokeToken) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(revokeToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }).catch(() => undefined);
    }
    await rm(this.tokenFilePath, { force: true });
  }

  async accessToken(): Promise<string> {
    const token = await this.readToken();
    if (!token) throw new Error('Google Calendar не авторизован. Подключите аккаунт в разделе MCP.');
    if (token.access_token && token.expires_at > Date.now() + 60_000) return token.access_token;
    if (!token.refresh_token || !this.clientId || !this.clientSecret) {
      throw new Error('Сессия Google истекла. Переподключите аккаунт в разделе MCP.');
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== 'string') throw new Error('Не удалось обновить Google OAuth token.');
    const refreshed: GoogleOAuthToken = {
      ...token,
      access_token: payload.access_token,
      expires_at: Date.now() + (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) * 1000,
      scope: typeof payload.scope === 'string' ? payload.scope : token.scope
    };
    await this.saveToken(refreshed);
    return refreshed.access_token;
  }

  private async readToken(): Promise<GoogleOAuthToken | null> {
    try {
      const parsed = JSON.parse(await readFile(this.tokenFilePath, 'utf8')) as Partial<GoogleOAuthToken>;
      if (typeof parsed.access_token !== 'string' || typeof parsed.expires_at !== 'number') return null;
      return parsed as GoogleOAuthToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  private async saveToken(token: GoogleOAuthToken): Promise<void> {
    await mkdir(path.dirname(this.tokenFilePath), { recursive: true });
    await writeFile(this.tokenFilePath, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export class GoogleCalendarMcpServer {
  private readonly registeredTools = new Map<string, {
    definition: McpToolDefinition;
    handler: (args: unknown) => Promise<McpToolResult>;
  }>();

  constructor(private readonly auth: GoogleCalendarAuth, private readonly fetcher: typeof fetch = fetch) {
    this.registerTool(listEventsTool, (args) => this.listEvents(args));
    this.registerTool(createEventTool, (args) => this.createEvent(args));
    this.registerTool(deleteEventTool, (args) => this.deleteEvent(args));
  }

  registerTool(definition: McpToolDefinition, handler: (args: unknown) => Promise<McpToolResult>): void {
    if (this.registeredTools.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    this.registeredTools.set(definition.name, { definition, handler });
  }

  listTools(): McpToolDefinition[] {
    return [...this.registeredTools.values()].map(({ definition }) => definition);
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const registered = this.registeredTools.get(name);
    if (!registered) return textResult({ error: `Unknown tool: ${name}` }, true);
    return registered.handler(args);
  }

  private async listEvents(args: unknown): Promise<McpToolResult> {
    try {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
      const maxResults = normalizeMaxResults(input.maxResults);
      const timeMin = optionalDateTime(input.timeMin, 'timeMin') ?? new Date().toISOString();
      const timeMax = optionalDateTime(input.timeMax, 'timeMax');
      if (timeMax && Date.parse(timeMax) <= Date.parse(timeMin)) throw new Error('timeMax должен быть позже timeMin.');
      const query = typeof input.query === 'string' && input.query.trim() ? input.query.trim() : undefined;
      const calendarId = requireString(input.calendarId, 'primary');
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('timeMin', timeMin);
      if (timeMax) url.searchParams.set('timeMax', timeMax);
      if (query) url.searchParams.set('q', query);
      url.searchParams.set('maxResults', String(maxResults));
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('showDeleted', 'false');

      const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${await this.auth.accessToken()}` } });
      const payload = await response.json() as CalendarEventsResponse;
      if (!response.ok) throw new Error(payload.error?.message ?? `Google Calendar API вернул HTTP ${response.status}.`);
      const result = {
        calendar: payload.summary ?? calendarId,
        timeZone: payload.timeZone ?? null,
        period: { timeMin, timeMax: timeMax ?? null },
        count: payload.items?.length ?? 0,
        events: (payload.items ?? []).map((event) => ({
          id: event.id ?? null,
          status: event.status ?? null,
          summary: limitedText(event.summary, 300) ?? '(без названия)',
          start: event.start?.dateTime ?? event.start?.date ?? null,
          end: event.end?.dateTime ?? event.end?.date ?? null,
          timeZone: event.start?.timeZone ?? null,
          location: limitedText(event.location, 500),
          description: limitedText(event.description, 2_000),
          attendees: (event.attendees ?? []).slice(0, 50).map((attendee) => ({
            email: attendee.email ?? null,
            name: attendee.displayName ?? null,
            response: attendee.responseStatus ?? null
          })),
          url: event.htmlLink ?? null
        }))
      };
      return textResult(result);
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : 'Не удалось получить события Google Calendar.' }, true);
    }
  }

  private async createEvent(args: unknown): Promise<McpToolResult> {
    try {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
      const summary = requireString(input.summary, '');
      if (!summary) throw new Error('summary обязателен.');
      if (summary.length > 300) throw new Error('summary не должен быть длиннее 300 символов.');
      const start = optionalDateTime(input.start, 'start');
      const end = optionalDateTime(input.end, 'end');
      if (!start || !end) throw new Error('start и end обязательны.');
      if (Date.parse(end) <= Date.parse(start)) throw new Error('end должен быть позже start.');
      const calendarId = requireString(input.calendarId, 'primary');
      const timeZone = typeof input.timeZone === 'string' && input.timeZone.trim()
        ? input.timeZone.trim()
        : DEFAULT_CALENDAR_TIME_ZONE;
      const description = typeof input.description === 'string' ? input.description.trim().slice(0, 4_000) : undefined;
      const location = typeof input.location === 'string' ? input.location.trim().slice(0, 500) : undefined;
      const attendees = input.attendees === undefined ? [] : input.attendees;
      if (!Array.isArray(attendees) || attendees.length > 50 || attendees.some((email) => typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email))) {
        throw new Error('attendees должен быть массивом корректных email (не более 50).');
      }
      const sendUpdates = input.sendUpdates === undefined ? 'all' : input.sendUpdates;
      if (!['all', 'externalOnly', 'none'].includes(String(sendUpdates))) throw new Error('Некорректное значение sendUpdates.');

      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('sendUpdates', String(sendUpdates));
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.auth.accessToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary,
          ...(description ? { description } : {}),
          ...(location ? { location } : {}),
          start: { dateTime: start, timeZone },
          end: { dateTime: end, timeZone },
          ...(attendees.length > 0 ? { attendees: attendees.map((email) => ({ email })) } : {})
        })
      });
      const event = await response.json() as CalendarEvent & { error?: { message?: string } };
      if (!response.ok) throw new Error(event.error?.message ?? `Google Calendar API вернул HTTP ${response.status}.`);
      return textResult({
        created: true,
        event: {
          id: event.id ?? null,
          summary: event.summary ?? summary,
          start: event.start?.dateTime ?? start,
          end: event.end?.dateTime ?? end,
          location: event.location ?? location ?? null,
          url: event.htmlLink ?? null
        }
      });
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : 'Не удалось создать событие Google Calendar.' }, true);
    }
  }

  private async deleteEvent(args: unknown): Promise<McpToolResult> {
    try {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
      const eventId = requireString(input.eventId, '');
      if (!eventId) throw new Error('eventId обязателен. Сначала найдите событие через google_calendar_list_events.');
      if (eventId.length > 1_024) throw new Error('eventId слишком длинный.');
      const calendarId = requireString(input.calendarId, 'primary');
      const sendUpdates = input.sendUpdates === undefined ? 'all' : input.sendUpdates;
      if (!['all', 'externalOnly', 'none'].includes(String(sendUpdates))) throw new Error('Некорректное значение sendUpdates.');
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
      url.searchParams.set('sendUpdates', String(sendUpdates));
      const response = await this.fetcher(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await this.auth.accessToken()}` }
      });
      if (!response.ok) {
        let message = `Google Calendar API вернул HTTP ${response.status}.`;
        try {
          const payload = await response.json() as { error?: { message?: string } };
          message = payload.error?.message ?? message;
        } catch {
          // Google can return an empty body for some errors.
        }
        throw new Error(message);
      }
      return textResult({ deleted: true, eventId, calendarId });
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : 'Не удалось удалить событие Google Calendar.' }, true);
    }
  }

  async handleHttp(req: Request, res: Response): Promise<Response | void> {
    const message = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const id = message.id as string | number | null | undefined;
    const method = typeof message.method === 'string' ? message.method : '';
    if (method === 'notifications/initialized') return res.status(202).send();
    if (id === undefined) return res.status(202).send();
    const respond = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
      return respond({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'google-calendar-mcp', version: '1.0.0' }
      });
    }
    if (method === 'tools/list') return respond({ tools: this.listTools() });
    if (method === 'tools/call') {
      const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
      return respond(await this.callTool(String(params.name ?? ''), params.arguments));
    }
    return res.status(404).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }
}

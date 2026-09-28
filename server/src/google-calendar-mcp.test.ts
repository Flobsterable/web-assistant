import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { GoogleCalendarAuth, GoogleCalendarMcpServer } from './mcp/google-calendar-mcp.js';
import { formatZonedDateTime, McpAgentRuntime } from './mcp/mcp-agent-runtime.js';

async function sendJsonRpc(mcp: GoogleCalendarMcpServer, body: Record<string, unknown>) {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    send(value?: unknown) {
      payload = value;
      return this;
    }
  } as unknown as Response;
  await mcp.handleHttp({ body } as Request, response);
  return { statusCode, payload };
}

test('Google Calendar MCP supports initialize, tools/list and tools/call', async () => {
  const auth = new GoogleCalendarAuth('/tmp/not-used-google-token.json', null, null, 'http://localhost/callback');
  const mcp = new GoogleCalendarMcpServer(auth);
  const initialized = await sendJsonRpc(mcp, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' }
  });
  assert.equal(initialized.statusCode, 200);
  assert.equal((initialized.payload as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'google-calendar-mcp');

  const listed = await sendJsonRpc(mcp, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (listed.payload as { result: { tools: Array<{ name: string; inputSchema: { properties: object } }> } }).result.tools;
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.map((tool) => tool.name), [
    'google_calendar_list_events', 'google_calendar_create_event', 'google_calendar_delete_event'
  ]);
  assert.equal(tools[0].inputSchema.properties !== undefined, true);

  const called = await sendJsonRpc(mcp, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'google_calendar_list_events', arguments: { maxResults: 5 } }
  });
  const result = (called.payload as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /не авторизован/i);
});

test('Google Calendar MCP validates tool arguments before calling the API', async () => {
  const auth = new GoogleCalendarAuth('/tmp/not-used-google-token.json', null, null, 'http://localhost/callback');
  const mcp = new GoogleCalendarMcpServer(auth);
  const result = await mcp.callTool('google_calendar_list_events', { maxResults: 100 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /от 1 до 50/);
  const invalidMeeting = await mcp.callTool('google_calendar_create_event', {
    summary: 'Короткая встреча', start: '2026-09-28T10:00:00Z', end: '2026-09-28T09:00:00Z'
  });
  assert.equal(invalidMeeting.isError, true);
  assert.match(invalidMeeting.content[0].text, /позже start/);
});

test('Google Calendar MCP creates an event through the Calendar API', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const auth = { async accessToken() { return 'test-token'; } } as unknown as GoogleCalendarAuth;
  const mcp = new GoogleCalendarMcpServer(auth, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      id: 'event-1', summary: 'Демо', htmlLink: 'https://calendar.google.com/event?eid=1',
      start: { dateTime: '2026-09-29T04:00:00.000Z' }, end: { dateTime: '2026-09-29T04:30:00.000Z' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await mcp.callTool('google_calendar_create_event', {
    summary: 'Демо', start: '2026-09-29T10:00:00+06:00', end: '2026-09-29T10:30:00+06:00',
    attendees: ['user@example.com']
  });
  assert.equal(result.isError, undefined);
  assert.match(requestUrl, /calendars\/primary\/events\?sendUpdates=all/);
  assert.equal(requestInit?.method, 'POST');
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bearer test-token');
  const body = JSON.parse(String(requestInit?.body)) as {
    summary: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    attendees: Array<{ email: string }>;
  };
  assert.equal(body.summary, 'Демо');
  assert.deepEqual(body.start, { dateTime: '2026-09-29T04:00:00.000Z', timeZone: 'Asia/Omsk' });
  assert.deepEqual(body.end, { dateTime: '2026-09-29T04:30:00.000Z', timeZone: 'Asia/Omsk' });
  assert.deepEqual(body.attendees, [{ email: 'user@example.com' }]);
  assert.equal((result.structuredContent as { event: { id: string } }).event.id, 'event-1');
});

test('agent runtime exposes local time and offset to the tool planner', async () => {
  assert.equal(formatZonedDateTime(new Date('2026-09-28T08:00:00.000Z'), 'Asia/Omsk'), '2026-09-28T14:00:00+06:00');
  let systemPrompt = '';
  const runtime = new McpAgentRuntime({
    async listTools() {
      return [{ name: 'google_calendar_create_event', description: 'create', inputSchema: { type: 'object' } }];
    },
    async callTool() {
      throw new Error('Tool must not be called in this prompt test.');
    }
  }, async (messages) => {
    systemPrompt = messages[0]?.content ?? '';
    return { answer: '{"tool":null,"arguments":{}}' };
  }, 6, 'Asia/Omsk');
  await runtime.resolve('Встреча в 14:00');
  assert.match(systemPrompt, /Часовой пояс пользователя: Asia\/Omsk/u);
  assert.match(systemPrompt, /14:00:00\+06:00/u);
  assert.match(systemPrompt, /а не как 14:00:00Z/u);
});

test('Google Calendar MCP deletes only an event with an explicit ID', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const auth = { async accessToken() { return 'test-token'; } } as unknown as GoogleCalendarAuth;
  const mcp = new GoogleCalendarMcpServer(auth, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(null, { status: 204 });
  });
  const missingId = await mcp.callTool('google_calendar_delete_event', {});
  assert.equal(missingId.isError, true);

  const result = await mcp.callTool('google_calendar_delete_event', { eventId: 'event/with special', sendUpdates: 'all' });
  assert.equal(result.isError, undefined);
  assert.match(requestUrl, /events\/event%2Fwith%20special\?sendUpdates=all/);
  assert.equal(requestInit?.method, 'DELETE');
  assert.equal((result.structuredContent as { deleted: boolean }).deleted, true);
});

test('agent runtime selects an MCP tool, calls it and returns grounded context', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const runtime = new McpAgentRuntime({
    async listTools() {
      return [{
        name: 'google_calendar_list_events',
        description: 'List events',
        inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' } } }
      }];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: '{"count":1,"events":[{"summary":"Demo"}]}' }] };
    }
  }, async () => ({
    answer: '{"tool":"google_calendar_list_events","arguments":{"maxResults":3}}'
  }));

  const resolved = await runtime.resolve('Что у меня в календаре?');
  assert.deepEqual(calls, [{ name: 'google_calendar_list_events', args: { maxResults: 3 } }]);
  assert.equal(resolved.calls[0].name, 'google_calendar_list_events');
  assert.match(resolved.contextMessages[0].content, /Demo/);
  assert.match(resolved.contextMessages[0].content, /untrusted data/i);
});

test('agent runtime automatically composes multiple MCP tools and passes results between them', async () => {
  const todos = [{ id: 'todo-1', title: 'Подготовить отчёт', status: 'pending', priority: 'high' }];
  const calendarEvents = [{ id: 'event-1', summary: 'Встреча из календаря', start: '2026-09-28T10:00:00.000Z' }];
  const report = {
    title: 'Отчёт по задачам', generatedAt: '2026-09-28T10:00:00.000Z', markdown: '# Отчёт',
    todoCount: 1, sourceTodoIds: ['todo-1'], metrics: { pending: 1, completed: 0, overdue: 0, highPriority: 1 }
  };
  const reportId = 'report-1';
  const validationId = 'validation-1';
  const planned = [
    { tool: 'planner_list_todos', arguments: { status: 'pending' } },
    { tool: 'google_calendar_list_events', arguments: { timeMin: '2026-09-27T18:00:00.000Z', timeMax: '2026-09-28T18:00:00.000Z' } },
    { tool: 'planner_build_report', arguments: { todos, calendarEvents } },
    { tool: 'planner_validate_report', arguments: { reportId } },
    { tool: 'planner_save_report', arguments: { validationId, fileName: 'todos.md' } },
    { tool: null, arguments: {} }
  ];
  let planningStep = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const runtime = new McpAgentRuntime({
    async listTools() {
      return ['planner_list_todos', 'google_calendar_list_events', 'planner_build_report', 'planner_validate_report', 'planner_save_report'].map((name) => ({
        name, description: name, inputSchema: { type: 'object' }
      }));
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'planner_list_todos') return { content: [{ type: 'text', text: JSON.stringify({ todos }) }], structuredContent: { todos } };
      if (name === 'google_calendar_list_events') return { content: [{ type: 'text', text: JSON.stringify({ events: calendarEvents }) }], structuredContent: { events: calendarEvents } };
      if (name === 'planner_build_report') return { content: [{ type: 'text', text: JSON.stringify({ reportId }) }], structuredContent: { reportId } };
      if (name === 'planner_validate_report') return { content: [{ type: 'text', text: JSON.stringify({ validationId, valid: true }) }], structuredContent: { validationId, valid: true } };
      return { content: [{ type: 'text', text: JSON.stringify({ saved: true, path: '/tmp/todos.md', markdown: report.markdown, displayInAgent: true }) }] };
    }
  }, async (messages) => {
    if (planningStep > 0) assert.match(messages.at(-1)?.content ?? '', /mcp_tool_result/);
    return { answer: JSON.stringify(planned[planningStep++]) };
  });

  const resolved = await runtime.resolve('Составь отчёт по незавершённым задачам и сохрани его.');
  assert.deepEqual(calls.map((call) => call.name), [
    'planner_list_todos', 'google_calendar_list_events', 'planner_build_report', 'planner_validate_report', 'planner_save_report'
  ]);
  assert.deepEqual(calls[2].args.todos, todos);
  assert.deepEqual(calls[2].args.calendarEvents, calendarEvents);
  assert.equal(calls[3].args.reportId, reportId);
  assert.equal(calls[4].args.validationId, validationId);
  assert.equal(resolved.calls.length, 5);
  assert.match(resolved.contextMessages.at(-1)?.content ?? '', /автоматически покажет пользователю/);
});

test('agent runtime routes a meeting across calendar and planner MCP servers in the required order', async () => {
  const meeting = {
    id: 'event-42', summary: 'Синк с командой', start: '2026-09-29T04:00:00.000Z',
    end: '2026-09-29T04:30:00.000Z', url: 'https://calendar.google.com/event?eid=42'
  };
  const planned = [
    { tool: 'google_calendar_create_event', arguments: { summary: meeting.summary, start: meeting.start, end: meeting.end } },
    { tool: 'planner_save_todos', arguments: { todos: [{
      title: meeting.summary,
      dueAt: meeting.start,
      description: `Google Calendar event: ${meeting.id}\n${meeting.url}`
    }] } },
    { tool: null, arguments: {} }
  ];
  let step = 0;
  const calls: Array<{ server: string; name: string; args: Record<string, unknown> }> = [];
  const calendarClient = {
    async listTools() { return [{ name: 'google_calendar_create_event', description: 'create', inputSchema: { type: 'object' } }]; },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ server: 'calendar', name, args });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ created: true, event: meeting }) }], structuredContent: { created: true, event: meeting } };
    }
  };
  const plannerClient = {
    async listTools() { return [{ name: 'planner_save_todos', description: 'save', inputSchema: { type: 'object' } }]; },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ server: 'planner', name, args });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ createdCount: 1 }) }] };
    }
  };
  const { CombinedMcpToolClient } = await import('./mcp/mcp-agent-runtime.js');
  const runtime = new McpAgentRuntime(new CombinedMcpToolClient([calendarClient, plannerClient]), async () => ({
    answer: JSON.stringify(planned[step++])
  }));

  const resolved = await runtime.resolve('Поставь синк с командой завтра с 10:00 до 10:30');
  assert.deepEqual(calls.map(({ server, name }) => `${server}:${name}`), [
    'calendar:google_calendar_create_event', 'planner:planner_save_todos'
  ]);
  assert.equal((calls[1].args.todos as Array<{ dueAt: string }>)[0].dueAt, meeting.start);
  assert.match(JSON.stringify(calls[1].args), /event-42/);
  assert.equal(resolved.calls.length, 2);
});

test('agent runtime deletes a meeting and its linked todo in a safe cross-server order', async () => {
  const event = { id: 'event-42', summary: 'Синк', start: '2026-09-29T04:00:00.000Z' };
  const todo = { id: 'todo-42', title: 'Синк', description: 'Google Calendar event: event-42' };
  const planned = [
    { tool: 'google_calendar_list_events', arguments: { query: 'Синк' } },
    { tool: 'google_calendar_delete_event', arguments: { eventId: event.id } },
    { tool: 'planner_list_todos', arguments: { status: 'pending' } },
    { tool: 'planner_delete_todos', arguments: { ids: [todo.id] } },
    { tool: null, arguments: {} }
  ];
  let step = 0;
  const calls: string[] = [];
  const runtime = new McpAgentRuntime({
    async listTools() {
      return planned.slice(0, 4).map(({ tool }) => ({ name: tool as string, description: tool as string, inputSchema: { type: 'object' } }));
    },
    async callTool(name) {
      calls.push(name);
      if (name === 'google_calendar_list_events') return { content: [{ type: 'text', text: JSON.stringify({ events: [event] }) }] };
      if (name === 'google_calendar_delete_event') return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, eventId: event.id }) }] };
      if (name === 'planner_list_todos') return { content: [{ type: 'text', text: JSON.stringify({ todos: [todo] }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ deletedCount: 1, deleted: [todo] }) }] };
    }
  }, async () => ({ answer: JSON.stringify(planned[step++]) }));

  await runtime.resolve('Удали встречу Синк');
  assert.deepEqual(calls, [
    'google_calendar_list_events', 'google_calendar_delete_event', 'planner_list_todos', 'planner_delete_todos'
  ]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { GoogleCalendarAuth, GoogleCalendarMcpServer } from './mcp/google-calendar-mcp.js';
import { McpAgentRuntime } from './mcp/mcp-agent-runtime.js';

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
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'google_calendar_list_events');
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
  const report = {
    title: 'Отчёт по задачам', generatedAt: '2026-09-28T10:00:00.000Z', markdown: '# Отчёт',
    todoCount: 1, sourceTodoIds: ['todo-1'], metrics: { pending: 1, completed: 0, overdue: 0, highPriority: 1 }
  };
  const reportId = 'report-1';
  const validationId = 'validation-1';
  const planned = [
    { tool: 'planner_list_todos', arguments: { status: 'pending' } },
    { tool: 'planner_build_report', arguments: { todos } },
    { tool: 'planner_validate_report', arguments: { reportId } },
    { tool: 'planner_save_report', arguments: { validationId, fileName: 'todos.md' } },
    { tool: null, arguments: {} }
  ];
  let planningStep = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const runtime = new McpAgentRuntime({
    async listTools() {
      return ['planner_list_todos', 'planner_build_report', 'planner_validate_report', 'planner_save_report'].map((name) => ({
        name, description: name, inputSchema: { type: 'object' }
      }));
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'planner_list_todos') return { content: [{ type: 'text', text: JSON.stringify({ todos }) }], structuredContent: { todos } };
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
    'planner_list_todos', 'planner_build_report', 'planner_validate_report', 'planner_save_report'
  ]);
  assert.deepEqual(calls[1].args.todos, todos);
  assert.equal(calls[2].args.reportId, reportId);
  assert.equal(calls[3].args.validationId, validationId);
  assert.equal(resolved.calls.length, 4);
  assert.match(resolved.contextMessages.at(-1)?.content ?? '', /автоматически покажет пользователю/);
});

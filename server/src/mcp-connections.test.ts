import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonMcpConnectionStore } from './mcp/mcp-connections.js';

test('MCP connections are persisted, updated by endpoint and removed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-connections-'));
  const filePath = path.join(directory, 'connections.json');
  const store = new JsonMcpConnectionStore(filePath);

  try {
    const first = await store.save({
      endpoint: 'https://example.com/mcp',
      server: { name: 'Example MCP', version: '1.0.0' },
      tools: [{ name: 'search', description: 'Search documents', inputSchema: { type: 'object' } }],
    });
    const updated = await store.save({
      endpoint: 'https://example.com/mcp',
      server: { name: 'Example MCP', version: '1.1.0' },
      tools: [{ name: 'read', description: 'Read a document', inputSchema: { type: 'object' } }],
    });

    assert.equal(updated.id, first.id);
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.list())[0].tools[0].name, 'read');
    assert.equal(await store.remove(first.id), true);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.remove(first.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persisted MCP registry contains no authorization header values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-connections-'));
  const filePath = path.join(directory, 'connections.json');
  const store = new JsonMcpConnectionStore(filePath);

  try {
    await store.save({
      endpoint: 'https://example.com/mcp',
      server: { name: 'Example MCP', version: null },
      tools: [],
    });
    const contents = await readFile(filePath, 'utf8');
    assert.equal(contents.includes('Authorization'), false);
    assert.equal(contents.includes('Bearer token'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

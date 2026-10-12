import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const gatewayDirectory = path.dirname(fileURLToPath(import.meta.url));

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway did not start.')), 5_000);
    const onData = (chunk) => {
      if (!String(chunk).includes('Private LLM gateway:')) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => reject(new Error(`Gateway exited early with code ${code}.`)));
  });
}

test('gateway authenticates, clamps Ollama limits and rejects excess concurrency', async (t) => {
  let receivedPayload = null;
  let releaseSlowRequest;
  let slowRequestReceived;
  const slowRequestStarted = new Promise((resolve) => { slowRequestReceived = resolve; });
  const slowRequestRelease = new Promise((resolve) => { releaseSlowRequest = resolve; });

  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedPayload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    if (receivedPayload?.messages?.[0]?.content === 'slow') {
      slowRequestReceived();
      await slowRequestRelease;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: 'ok' }, done: true }));
  });
  let upstreamPort;
  try {
    upstreamPort = await listen(upstream);
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('The execution sandbox does not allow listening on loopback sockets.');
      return;
    }
    throw error;
  }
  const gatewayPort = await unusedPort();
  const apiKey = 'test-key-with-more-than-24-characters';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: gatewayDirectory,
    env: {
      ...process.env,
      UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(gatewayPort),
      LLM_API_KEY: apiKey,
      RATE_LIMIT_RPM: '50',
      MAX_CONTEXT_TOKENS: '4096',
      MAX_OUTPUT_TOKENS: '100',
      MAX_CONCURRENT_REQUESTS: '1',
      QUEUE_LIMIT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(async () => {
    releaseSlowRequest?.();
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
  });

  await waitForReady(child);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const unauthorized = await fetch(`${baseUrl}/health`);
  assert.equal(unauthorized.status, 401);

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'test',
      stream: false,
      messages: [{ role: 'user', content: 'normal' }],
      options: { num_ctx: 999_999, num_predict: 999_999 }
    })
  });
  assert.equal(response.status, 200);
  assert.equal(receivedPayload.options.num_ctx, 4096);
  assert.equal(receivedPayload.options.num_predict, 100);

  const first = fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'slow' }] })
  });
  await slowRequestStarted;
  const overflow = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'overflow' }] })
  });
  assert.equal(overflow.status, 503);
  releaseSlowRequest();
  assert.equal((await first).status, 200);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateTokensPerSecond,
  nanosecondsToMilliseconds,
  ollamaNativeBaseUrl,
  requestOllamaCompletion
} from './ollama-client.js';

test('ollamaNativeBaseUrl accepts native and OpenAI-compatible URLs', () => {
  assert.equal(ollamaNativeBaseUrl('http://192.168.1.50:11434/v1'), 'http://192.168.1.50:11434');
  assert.equal(ollamaNativeBaseUrl('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434');
  assert.equal(ollamaNativeBaseUrl('http://localhost:11434/api/chat'), 'http://localhost:11434');
});

test('Ollama duration helpers expose milliseconds and tokens per second', () => {
  assert.equal(nanosecondsToMilliseconds(1_250_000_000), 1250);
  assert.equal(calculateTokensPerSecond(50, 2_000_000_000), 25);
  assert.equal(calculateTokensPerSecond(0, 2_000_000_000), null);
});

test('native Ollama request sends generation limits and reads performance metrics', async () => {
  let receivedBody: Record<string, unknown> | null = null;
  let receivedUrl = '';
  let receivedAuthorization = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    receivedUrl = String(input);
    receivedAuthorization = new Headers(init?.headers).get('Authorization') ?? '';
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
        message: { content: '{"answer":"ok","citations":[]}' },
        done_reason: 'stop',
        prompt_eval_count: 100,
        eval_count: 40,
        total_duration: 3_000_000_000,
        eval_duration: 2_000_000_000
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await requestOllamaCompletion({
      baseUrl: 'http://ollama.test:11434/v1',
      apiKey: 'private-test-key',
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      json: true,
      settings: { temperature: 0.1, contextWindow: 8192, maxOutputTokens: 600, topP: 0.9, seed: 42 }
    });
    const actualBody = receivedBody as unknown as Record<string, unknown>;
    const options = actualBody.options as Record<string, unknown>;
    assert.equal(receivedUrl, 'http://ollama.test:11434/api/chat');
    assert.equal(receivedAuthorization, 'Bearer private-test-key');
    assert.deepEqual(options, { temperature: 0.1, num_ctx: 8192, num_predict: 600, top_p: 0.9, seed: 42 });
    assert.equal(actualBody.format, 'json');
    assert.equal(result.inputTokens, 100);
    assert.equal(result.outputTokens, 40);
    assert.equal(result.tokensPerSecond, 20);
    assert.equal(result.totalDurationMs, 3000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

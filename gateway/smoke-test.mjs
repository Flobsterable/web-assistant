const baseUrl = (process.env.PUBLIC_LLM_BASE_URL || '').replace(/\/+$/, '');
const apiKey = process.env.LLM_API_KEY || '';
const model = process.env.TEST_MODEL || '';
const concurrency = Math.max(1, Number(process.env.TEST_CONCURRENCY) || 4);

if (!baseUrl || !apiKey || !model) {
  throw new Error('Set PUBLIC_LLM_BASE_URL, LLM_API_KEY and TEST_MODEL in gateway/.env.');
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json'
};

async function request(path, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: response.status, elapsedMs: Math.round(performance.now() - startedAt), data };
}

const health = await request('/health');
console.log('health', health);
if (health.status !== 200) process.exitCode = 1;

const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => request('/api/chat', {
  method: 'POST',
  body: JSON.stringify({
    model,
    stream: false,
    messages: [{ role: 'user', content: `Ответь только словом: test-${index + 1}` }],
    options: { num_ctx: 999999, num_predict: 16, temperature: 0 }
  })
})));

console.table(results.map((result, index) => ({
  request: index + 1,
  status: result.status,
  elapsedMs: result.elapsedMs,
  answer: result.data?.message?.content || result.data?.error || 'no answer'
})));

if (results.some((result) => result.status !== 200)) process.exitCode = 1;

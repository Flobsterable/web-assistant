import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

function integerEnv(name, fallback, minimum = 1) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

const config = {
  upstreamUrl: new URL(process.env.UPSTREAM_URL?.trim() || 'http://127.0.0.1:11434'),
  host: process.env.GATEWAY_HOST?.trim() || '127.0.0.1',
  port: integerEnv('GATEWAY_PORT', 8080),
  apiKey: process.env.LLM_API_KEY?.trim() || '',
  rateLimitRpm: integerEnv('RATE_LIMIT_RPM', 20),
  maxContextTokens: integerEnv('MAX_CONTEXT_TOKENS', 8192),
  maxOutputTokens: integerEnv('MAX_OUTPUT_TOKENS', 600),
  maxBodyBytes: integerEnv('MAX_BODY_BYTES', 2 * 1024 * 1024),
  maxConcurrentRequests: integerEnv('MAX_CONCURRENT_REQUESTS', 2),
  queueLimit: integerEnv('QUEUE_LIMIT', 8, 0),
  upstreamTimeoutMs: integerEnv('UPSTREAM_TIMEOUT_MS', 10 * 60 * 1000)
};

if (config.apiKey.length < 24 || config.apiKey.startsWith('replace-with-')) {
  throw new Error('LLM_API_KEY must be a random value containing at least 24 characters.');
}

const allowedRoutes = new Map([
  ['GET /api/tags', true],
  ['GET /api/ps', true],
  ['GET /v1/models', true],
  ['POST /api/chat', true],
  ['POST /api/generate', true],
  ['POST /api/show', true],
  ['POST /api/embed', true],
  ['POST /v1/chat/completions', true],
  ['POST /v1/completions', true],
  ['POST /v1/embeddings', true]
]);

const rateWindows = new Map();
let activeRequests = 0;
const requestQueue = [];

function json(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function suppliedApiKey(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  const apiKey = req.headers['x-api-key'];
  return Array.isArray(apiKey) ? apiKey[0] : apiKey || '';
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function takeRateLimit(req) {
  const now = Date.now();
  const key = clientAddress(req);
  const current = rateWindows.get(key);
  const window = !current || now - current.startedAt >= 60_000
    ? { startedAt: now, count: 0 }
    : current;
  window.count += 1;
  rateWindows.set(key, window);
  const remaining = Math.max(0, config.rateLimitRpm - window.count);
  const resetSeconds = Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1000));
  return { allowed: window.count <= config.rateLimitRpm, remaining, resetSeconds };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function positiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function enforceGenerationLimits(pathname, body) {
  if (!body.length) return body;
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('Request body must contain valid JSON.');
    error.statusCode = 400;
    throw error;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body;

  if (pathname === '/api/chat' || pathname === '/api/generate') {
    const options = payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)
      ? payload.options
      : {};
    options.num_ctx = Math.min(positiveInteger(options.num_ctx) ?? config.maxContextTokens, config.maxContextTokens);
    options.num_predict = Math.min(positiveInteger(options.num_predict) ?? config.maxOutputTokens, config.maxOutputTokens);
    payload.options = options;
  }

  if (pathname === '/v1/chat/completions' || pathname === '/v1/completions') {
    const requested = positiveInteger(payload.max_completion_tokens) ?? positiveInteger(payload.max_tokens);
    payload.max_tokens = Math.min(requested ?? config.maxOutputTokens, config.maxOutputTokens);
    delete payload.max_completion_tokens;
    const options = payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)
      ? payload.options
      : {};
    options.num_ctx = Math.min(positiveInteger(options.num_ctx) ?? config.maxContextTokens, config.maxContextTokens);
    payload.options = options;
  }

  const limited = Buffer.from(JSON.stringify(payload));
  if (limited.length > config.maxBodyBytes) {
    const error = new Error('Request body is too large after normalization.');
    error.statusCode = 413;
    throw error;
  }
  return limited;
}

function waitForCapacity() {
  if (activeRequests < config.maxConcurrentRequests) {
    activeRequests += 1;
    return Promise.resolve();
  }
  if (requestQueue.length >= config.queueLimit) return null;
  return new Promise((resolve) => requestQueue.push(resolve)).then(() => {
    activeRequests += 1;
  });
}

function releaseCapacity() {
  activeRequests = Math.max(0, activeRequests - 1);
  requestQueue.shift()?.();
}

function proxyRequest(req, res, body) {
  return new Promise((resolve) => {
    const upstream = new URL(req.url || '/', config.upstreamUrl);
    const transport = upstream.protocol === 'https:' ? https : http;
    const headers = {
      accept: req.headers.accept || 'application/json',
      'content-type': req.headers['content-type'] || 'application/json',
      'content-length': body.length,
      host: upstream.host,
      'user-agent': 'private-local-llm-gateway/1.0'
    };
    const upstreamRequest = transport.request(upstream, {
      method: req.method,
      headers,
      timeout: config.upstreamTimeoutMs
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      delete responseHeaders['keep-alive'];
      responseHeaders['cache-control'] = 'no-store';
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
      upstreamResponse.on('end', resolve);
      upstreamResponse.on('error', () => resolve());
    });
    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('Upstream request timed out.')));
    upstreamRequest.on('error', (error) => {
      if (!res.headersSent) json(res, 502, { error: `LLM upstream unavailable: ${error.message}` });
      else res.destroy(error);
      resolve();
    });
    if (body.length) upstreamRequest.write(body);
    upstreamRequest.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (!secureEqual(suppliedApiKey(req), config.apiKey)) {
    return json(res, 401, { error: 'Invalid or missing API key.' }, { 'WWW-Authenticate': 'Bearer' });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      status: 'ok',
      activeRequests,
      queuedRequests: requestQueue.length,
      limits: {
        requestsPerMinute: config.rateLimitRpm,
        maxContextTokens: config.maxContextTokens,
        maxOutputTokens: config.maxOutputTokens,
        maxConcurrentRequests: config.maxConcurrentRequests
      }
    });
  }

  const pathname = new URL(req.url || '/', 'http://gateway.local').pathname;
  if (!allowedRoutes.has(`${req.method} ${pathname}`)) {
    return json(res, 404, { error: 'Endpoint is not exposed by this gateway.' });
  }

  const rate = takeRateLimit(req);
  res.setHeader('X-RateLimit-Limit', config.rateLimitRpm);
  res.setHeader('X-RateLimit-Remaining', rate.remaining);
  res.setHeader('X-RateLimit-Reset', rate.resetSeconds);
  if (!rate.allowed) {
    return json(res, 429, { error: 'Rate limit exceeded.' }, { 'Retry-After': rate.resetSeconds });
  }

  const capacity = waitForCapacity();
  if (!capacity) {
    return json(res, 503, { error: 'The LLM request queue is full.' }, { 'Retry-After': '5' });
  }

  await capacity;
  try {
    const rawBody = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const body = enforceGenerationLimits(pathname, rawBody);
    await proxyRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      json(res, error.statusCode || 500, { error: error.message || 'Gateway request failed.' });
    }
  } finally {
    releaseCapacity();
  }
});

server.requestTimeout = config.upstreamTimeoutMs + 5_000;
server.headersTimeout = 30_000;
server.listen(config.port, config.host, () => {
  console.log(`Private LLM gateway: http://${config.host}:${config.port}`);
  console.log(`Ollama upstream: ${config.upstreamUrl}`);
});

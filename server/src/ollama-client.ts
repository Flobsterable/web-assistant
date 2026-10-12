import { performance } from 'node:perf_hooks';

export type OllamaMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type OllamaGenerationSettings = {
  temperature: number;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  topP?: number | null;
  seed?: number | null;
};

export type OllamaCompletion = {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishReason: string | null;
  wallTimeMs: number;
  totalDurationMs: number | null;
  loadDurationMs: number | null;
  promptEvalDurationMs: number | null;
  evalDurationMs: number | null;
  tokensPerSecond: number | null;
};

type OllamaChatResponse = {
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  error?: string;
};

export type OllamaModelInfo = {
  model: string;
  parameterSize: string | null;
  quantizationLevel: string | null;
  format: string | null;
  family: string | null;
  sizeBytes: number | null;
  sizeVramBytes: number | null;
  contextLength: number | null;
};

type OllamaShowResponse = {
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    format?: string;
    family?: string;
  };
  error?: string;
};

type OllamaPsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    size_vram?: number;
    context_length?: number;
  }>;
  error?: string;
};

export function ollamaNativeBaseUrl(baseUrl: string) {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/v1(?:\/chat\/completions)?$/, '')
    .replace(/\/api\/chat$/, '');
}

export function nanosecondsToMilliseconds(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round((value / 1_000_000) * 100) / 100
    : null;
}

export function calculateTokensPerSecond(tokens: number | undefined, durationNanoseconds: number | undefined) {
  if (!tokens || !durationNanoseconds || durationNanoseconds <= 0) return null;
  return Math.round((tokens / (durationNanoseconds / 1_000_000_000)) * 100) / 100;
}

async function readJson<T extends { error?: string }>(response: Response): Promise<T> {
  const data = await response.json() as T;
  if (!response.ok) throw new Error(data.error || `Ollama вернула HTTP ${response.status}.`);
  return data;
}

function authorizationHeaders(apiKey?: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function requestOllamaCompletion(params: {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  messages: OllamaMessage[];
  settings: OllamaGenerationSettings;
  json?: boolean;
}): Promise<OllamaCompletion> {
  const startedAt = performance.now();
  const response = await fetch(`${ollamaNativeBaseUrl(params.baseUrl)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorizationHeaders(params.apiKey) },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: false,
      think: false,
      ...(params.json ? { format: 'json' } : {}),
      options: {
        temperature: params.settings.temperature,
        ...(params.settings.contextWindow === null || params.settings.contextWindow === undefined ? {} : { num_ctx: params.settings.contextWindow }),
        ...(params.settings.maxOutputTokens === null || params.settings.maxOutputTokens === undefined ? {} : { num_predict: params.settings.maxOutputTokens }),
        ...(params.settings.topP === null || params.settings.topP === undefined ? {} : { top_p: params.settings.topP }),
        ...(params.settings.seed === null || params.settings.seed === undefined ? {} : { seed: params.settings.seed })
      }
    })
  });
  const wallTimeMs = Math.round(performance.now() - startedAt);
  const data = await readJson<OllamaChatResponse>(response);
  const answer = data.message?.content?.trim();
  if (!answer) throw new Error(`Ollama не вернула финальный текст${data.done_reason ? ` (done_reason: ${data.done_reason})` : ''}.`);

  const inputTokens = data.prompt_eval_count ?? 0;
  const outputTokens = data.eval_count ?? 0;
  return {
    answer,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    finishReason: data.done_reason ?? null,
    wallTimeMs,
    totalDurationMs: nanosecondsToMilliseconds(data.total_duration),
    loadDurationMs: nanosecondsToMilliseconds(data.load_duration),
    promptEvalDurationMs: nanosecondsToMilliseconds(data.prompt_eval_duration),
    evalDurationMs: nanosecondsToMilliseconds(data.eval_duration),
    tokensPerSecond: calculateTokensPerSecond(data.eval_count, data.eval_duration)
  };
}

export async function inspectOllamaModel(baseUrl: string, model: string, apiKey?: string | null): Promise<OllamaModelInfo> {
  const nativeBaseUrl = ollamaNativeBaseUrl(baseUrl);
  const showResponse = await fetch(`${nativeBaseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorizationHeaders(apiKey) },
    body: JSON.stringify({ model })
  });
  const show = await readJson<OllamaShowResponse>(showResponse);
  const psResponse = await fetch(`${nativeBaseUrl}/api/ps`, {
    headers: authorizationHeaders(apiKey)
  });
  const ps = await readJson<OllamaPsResponse>(psResponse);
  const loaded = ps.models?.find((candidate) => candidate.name === model || candidate.model === model);

  return {
    model,
    parameterSize: show.details?.parameter_size ?? null,
    quantizationLevel: show.details?.quantization_level ?? null,
    format: show.details?.format ?? null,
    family: show.details?.family ?? null,
    sizeBytes: loaded?.size ?? null,
    sizeVramBytes: loaded?.size_vram ?? null,
    contextLength: loaded?.context_length ?? null
  };
}

import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3001;

type ModelConfig = {
  id: string;
  provider: 'openai-compatible' | 'gemini';
  title: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  sourceUrl: string | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  priceCurrency: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: {
    message?: string;
  };
};

type CompletionResult = {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated';
  cost: number | null;
  priceCurrency: string;
  elapsedMs: number;
  finishReason: string | null;
};

type ModelResult = CompletionResult & {
  id: string;
  provider: 'openai-compatible' | 'gemini';
  title: string;
  model: string;
  sourceUrl: string | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
};

type CompareResponse = {
  models: ModelResult[];
  comparison: CompletionResult;
};

type CompareRequest = {
  task: string;
};

const modelEnvPrefixes = ['MODEL_GEMINI', 'MODEL_FLASH', 'MODEL_PRO'] as const;

function readOptionalTextEnv(name: string) {
  const value = process.env[name]?.replace(/\\n/g, '\n').trim();
  return value || null;
}

function readRequiredTextEnv(name: string) {
  const value = readOptionalTextEnv(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readSharedApiKey() {
  const value = readOptionalTextEnv('DEEPSEEK_API_KEY');
  if (!value || value === 'your_deepseek_api_key_here') return null;
  return value;
}

function readGeminiApiKey() {
  const value = readOptionalTextEnv('GEMINI_API_KEY');
  if (!value || value === 'your_gemini_api_key_here') return null;
  return value;
}

function readRequiredSharedApiKey() {
  const value = readSharedApiKey();
  if (!value) throw new Error('вставьте реальный DEEPSEEK_API_KEY в файл .env.');
  return value;
}

function readRequiredGeminiApiKey() {
  const value = readGeminiApiKey();
  if (!value) throw new Error('вставьте реальный GEMINI_API_KEY в файл .env.');
  return value;
}

function readOptionalNumberEnv(name: string) {
  const value = readOptionalTextEnv(name);
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return parsed;
}

function readModelConfig(
  prefix: (typeof modelEnvPrefixes)[number],
  fallbackTitle: string,
  provider: ModelConfig['provider']
): ModelConfig {
  const sharedApiKey = provider === 'gemini' ? readRequiredGeminiApiKey() : readRequiredSharedApiKey();

  return {
    id: prefix.toLowerCase().replace('model_', ''),
    provider,
    title: readOptionalTextEnv(`${prefix}_TITLE`) ?? fallbackTitle,
    baseUrl: readRequiredTextEnv(`${prefix}_BASE_URL`).replace(/\/+$/, ''),
    model: readRequiredTextEnv(`${prefix}_NAME`),
    apiKey: readOptionalTextEnv(`${prefix}_API_KEY`) ?? sharedApiKey,
    sourceUrl: readOptionalTextEnv(`${prefix}_SOURCE_URL`),
    inputPricePerMillion: readOptionalNumberEnv(`${prefix}_INPUT_PRICE_PER_1M`),
    outputPricePerMillion: readOptionalNumberEnv(`${prefix}_OUTPUT_PRICE_PER_1M`),
    priceCurrency: readOptionalTextEnv(`${prefix}_PRICE_CURRENCY`) ?? readOptionalTextEnv('PRICE_CURRENCY') ?? 'USD'
  };
}

function readModelConfigs() {
  return [
    readModelConfig('MODEL_GEMINI', 'Слабая: Gemini 3.5 Flash-Lite', 'gemini'),
    readModelConfig('MODEL_FLASH', 'Средняя: DeepSeek V4 Flash', 'openai-compatible'),
    readModelConfig('MODEL_PRO', 'Сильная: DeepSeek V4 Pro', 'openai-compatible')
  ];
}

const defaultTask =
  readOptionalTextEnv('DEFAULT_TASK') ??
  'Объясни простыми словами, что такое градиентный бустинг, и приведи один пример применения.';

app.use(cors());
app.use(express.json({ limit: '64kb' }));

function readCompareRequest(body: unknown): CompareRequest | string {
  if (!body || typeof body !== 'object') return 'Request body is required.';

  const candidate = body as Record<string, unknown>;
  const task = typeof candidate.task === 'string' ? candidate.task.trim() : '';

  if (!task) return 'Task is required.';

  return { task };
}

function buildChatCompletionsUrl(baseUrl: string) {
  if (baseUrl.endsWith('/chat/completions')) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function estimateTokens(text: string) {
  const cyrillicWeight = /[а-яё]/i.test(text) ? 3.2 : 4;
  return Math.max(1, Math.ceil(text.length / cyrillicWeight));
}

function calculateCost(
  inputTokens: number | null,
  outputTokens: number | null,
  config: Pick<ModelConfig, 'inputPricePerMillion' | 'outputPricePerMillion'>
) {
  if (
    inputTokens === null ||
    outputTokens === null ||
    config.inputPricePerMillion === null ||
    config.outputPricePerMillion === null
  ) {
    return null;
  }

  return (inputTokens / 1_000_000) * config.inputPricePerMillion + (outputTokens / 1_000_000) * config.outputPricePerMillion;
}

async function requestCompletion(
  config: ModelConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  options?: { temperature?: number }
): Promise<CompletionResult> {
  if (config.provider === 'gemini') {
    return requestGeminiCompletion(config, messages, options);
  }

  return requestOpenAiCompatibleCompletion(config, messages, options);
}

async function requestOpenAiCompatibleCompletion(
  config: ModelConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  options?: { temperature?: number }
): Promise<CompletionResult> {
  const startedAt = performance.now();
  const response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: options?.temperature ?? 0.2,
      thinking: { type: 'disabled' }
    })
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  const data = (await response.json()) as ChatCompletionResponse;

  if (!response.ok) {
    throw new Error(data.error?.message || `${config.title}: API request failed.`);
  }

  const choice = data.choices?.[0];
  const answer = choice?.message?.content;
  const finishReason = choice?.finish_reason ?? null;

  if (!answer?.trim()) {
    throw new Error(`${config.title}: API returned no final text${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`);
  }

  const estimatedInputTokens = estimateTokens(messages.map((message) => message.content).join('\n'));
  const estimatedOutputTokens = estimateTokens(answer);
  const inputTokens = data.usage?.prompt_tokens ?? estimatedInputTokens;
  const outputTokens = data.usage?.completion_tokens ?? estimatedOutputTokens;
  const totalTokens = data.usage?.total_tokens ?? inputTokens + outputTokens;
  const tokenSource = data.usage?.total_tokens ? 'api' : 'estimated';

  return {
    answer,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenSource,
    cost: calculateCost(inputTokens, outputTokens, config),
    priceCurrency: config.priceCurrency,
    elapsedMs,
    finishReason
  };
}

async function requestGeminiCompletion(
  config: ModelConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  options?: { temperature?: number }
): Promise<CompletionResult> {
  const text = messages.map((message) => `${message.role === 'system' ? 'System' : 'User'}: ${message.content}`).join('\n\n');
  const startedAt = performance.now();
  const response = await fetch(`${config.baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text }]
        }
      ],
      generationConfig: {
        temperature: options?.temperature ?? 0.2
      }
    })
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  const data = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    throw new Error(data.error?.message || `${config.title}: API request failed.`);
  }

  const candidate = data.candidates?.[0];
  const answer = candidate?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  const finishReason = candidate?.finishReason ?? null;

  if (!answer) {
    throw new Error(`${config.title}: API returned no final text${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`);
  }

  const inputTokens = data.usageMetadata?.promptTokenCount ?? estimateTokens(text);
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? estimateTokens(answer);
  const totalTokens = data.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens;
  const tokenSource = data.usageMetadata?.totalTokenCount ? 'api' : 'estimated';

  return {
    answer,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenSource,
    cost: calculateCost(inputTokens, outputTokens, config),
    priceCurrency: config.priceCurrency,
    elapsedMs,
    finishReason
  };
}

function toModelResult(config: ModelConfig, result: CompletionResult): ModelResult {
  return {
    ...result,
    id: config.id,
    provider: config.provider,
    title: config.title,
    model: config.model,
    sourceUrl: config.sourceUrl,
    inputPricePerMillion: config.inputPricePerMillion,
    outputPricePerMillion: config.outputPricePerMillion
  };
}

function toPublicModelConfig(config: ModelConfig) {
  return {
    id: config.id,
    provider: config.provider,
    title: config.title,
    baseUrl: config.baseUrl,
    model: config.model,
    sourceUrl: config.sourceUrl,
    inputPricePerMillion: config.inputPricePerMillion,
    outputPricePerMillion: config.outputPricePerMillion,
    priceCurrency: config.priceCurrency
  };
}

app.get('/api/config', (_req: Request, res: Response) => {
  try {
    const models = readModelConfigs();

    return res.json({
      defaults: { task: defaultTask },
      models: models.map(toPublicModelConfig),
      hasApiKey: models.every((model) => Boolean(model.apiKey))
    });
  } catch (error) {
    return res.json({
      defaults: { task: defaultTask },
      models: [],
      hasApiKey: false,
      error: error instanceof Error ? error.message : 'Model configuration is incomplete.'
    });
  }
});

app.post('/api/compare', async (req: Request, res: Response) => {
  const request = readCompareRequest(req.body);

  if (typeof request === 'string') {
    return res.status(400).json({ error: request });
  }

  let modelConfigs: ModelConfig[];
  try {
    modelConfigs = readModelConfigs();
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Model configuration is incomplete.'
    });
  }

  const sharedMessages = [
    {
      role: 'system' as const,
      content:
        'Ты отвечаешь на русском языке. Дай полезный, точный и самостоятельный ответ. Не упоминай, что участвуешь в сравнении моделей.'
    },
    { role: 'user' as const, content: request.task }
  ];

  try {
    const completions = await Promise.all(modelConfigs.map((model) => requestCompletion(model, sharedMessages)));
    const models = completions.map((completion, index) => toModelResult(modelConfigs[index], completion));

    const comparisonPrompt = [
      'Сравни ответы моделей DeepSeek на один и тот же запрос.',
      'Нужно оценить: качество ответов, скорость, ресурсоёмкость, стоимость, количество токенов.',
      'Дай короткий вывод о различиях между моделями. Пиши по-русски.',
      '',
      `Исходный запрос: ${request.task}`,
      '',
      ...models.map((model) =>
        [
          `${model.title} (${model.model}):`,
          `время ${model.elapsedMs} мс, токены ${model.totalTokens}, стоимость ${model.cost ?? 'не указана'} ${model.priceCurrency}.`,
          model.answer
        ].join('\n')
      )
    ].join('\n\n');
    const comparisonModel = modelConfigs[modelConfigs.length - 1];
    const comparison = await requestCompletion(
      comparisonModel,
      [
        {
          role: 'system',
          content: 'Ты строгий, но краткий эксперт по оценке ответов LLM. Не придумывай метрики, которых нет в данных.'
        },
        { role: 'user', content: comparisonPrompt }
      ],
      { temperature: 0 }
    );

    const result: CompareResponse = { models, comparison };
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to contact model API.'
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

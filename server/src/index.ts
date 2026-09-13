import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AgentContextOverflowError, AgentMessage, JsonConversationStore, SimpleAgent } from './agent.js';
import {
  buildTokenDemo,
  calculateCost,
  createHistoryTokenStats,
  createTokenReport,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  normalizeTokenBudget
} from './token-meter.js';

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
  maxContextTokens: number;
  reservedOutputTokens: number;
};

type AgentDefinition = {
  provider: string;
  modelEnvPrefix: (typeof modelEnvPrefixes)[number];
  model: string;
  temperature: number;
  language: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  systemPrompt: string;
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

type AgentRequest = {
  message: string;
  sessionId?: string;
};

type PublicAgentMessage = {
  id: string;
  role: 'user' | 'agent';
  content: string;
  createdAt: string;
  tokenMeta?: PublicRequestTokenMeta;
  responseMeta?: PublicResponseTokenMeta;
};

type PublicAgentWindow = {
  sessionId: string;
  title: string;
};

type PublicAgentChat = PublicAgentWindow & {
  messageCount: number;
  fullHistoryTokens: number;
  updatedAt: string | null;
  lastMessagePreview: string | null;
};

type PublicRequestTokenMeta = {
  currentRequestTokens: number;
  fullHistoryTokens: number;
  selectedHistoryTokens: number;
  inputTokens: number;
  maxContextTokens: number;
  remainingInputTokens: number;
  priceCurrency: string;
  estimatedInputCost: number | null;
};

type PublicResponseTokenMeta = {
  outputTokens: number;
  totalTokens: number | null;
  priceCurrency: string;
  estimatedOutputCost: number | null;
  estimatedTotalCost: number | null;
};

const modelEnvPrefixes = ['MODEL_GEMINI', 'MODEL_FLASH', 'MODEL_PRO'] as const;
const agentDefinitionPath = path.resolve(__dirname, '../agents/simple-agent.md');
const agentDefinition = readAgentDefinition(agentDefinitionPath);

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

function readAgentDefinition(filePath: string): AgentDefinition {
  const content = readFileSync(filePath, 'utf8');
  const [metadataBlock, systemPromptBlock = ''] = content.split('## System Prompt');
  const metadata = new Map<string, string>();

  for (const line of metadataBlock.split('\n')) {
    const match = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (match) metadata.set(match[1], match[2].trim());
  }

  const modelEnvPrefix = metadata.get('model_env_prefix');

  if (!isModelEnvPrefix(modelEnvPrefix)) {
    throw new Error('server/agents/simple-agent.md has invalid model_env_prefix.');
  }

  return {
    provider: metadata.get('provider') ?? 'DeepSeek',
    modelEnvPrefix,
    model: metadata.get('model') ?? 'deepseek-v4-flash',
    temperature: readMetadataNumber(metadata, 'temperature', 0.2),
    language: metadata.get('language') ?? 'ru',
    maxContextTokens: readMetadataPositiveInteger(metadata, 'max_context_tokens', 600),
    reservedOutputTokens: readMetadataPositiveInteger(metadata, 'reserved_output_tokens', 150),
    systemPrompt: systemPromptBlock.trim()
  };
}

function isModelEnvPrefix(value: string | undefined): value is (typeof modelEnvPrefixes)[number] {
  return modelEnvPrefixes.some((prefix) => prefix === value);
}

function readMetadataNumber(metadata: Map<string, string>, key: string, fallback: number) {
  const value = metadata.get(key);
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readMetadataPositiveInteger(metadata: Map<string, string>, key: string, fallback: number) {
  const value = metadata.get(key);
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
    model: readOptionalTextEnv(`${prefix}_NAME`) ?? (prefix === agentDefinition.modelEnvPrefix ? agentDefinition.model : readRequiredTextEnv(`${prefix}_NAME`)),
    apiKey: readOptionalTextEnv(`${prefix}_API_KEY`) ?? sharedApiKey,
    sourceUrl: readOptionalTextEnv(`${prefix}_SOURCE_URL`),
    inputPricePerMillion: readOptionalNumberEnv(`${prefix}_INPUT_PRICE_PER_1M`),
    outputPricePerMillion: readOptionalNumberEnv(`${prefix}_OUTPUT_PRICE_PER_1M`),
    priceCurrency: readOptionalTextEnv(`${prefix}_PRICE_CURRENCY`) ?? readOptionalTextEnv('PRICE_CURRENCY') ?? 'USD',
    maxContextTokens:
      readOptionalNumberEnv(`${prefix}_MAX_CONTEXT_TOKENS`) ?? readOptionalNumberEnv('MODEL_MAX_CONTEXT_TOKENS') ?? agentDefinition.maxContextTokens,
    reservedOutputTokens:
      readOptionalNumberEnv(`${prefix}_RESERVED_OUTPUT_TOKENS`) ??
      readOptionalNumberEnv('MODEL_RESERVED_OUTPUT_TOKENS') ??
      agentDefinition.reservedOutputTokens
  };
}

function readModelConfigs() {
  return [
    readModelConfig('MODEL_GEMINI', 'Слабая: Gemini 3.5 Flash-Lite', 'gemini'),
    readModelConfig('MODEL_FLASH', 'Средняя: DeepSeek V4 Flash', 'openai-compatible'),
    readModelConfig('MODEL_PRO', 'Сильная: DeepSeek V4 Pro', 'openai-compatible')
  ];
}

function readAgentModelConfig() {
  return readModelConfig(agentDefinition.modelEnvPrefix, 'DeepSeek V4 Flash', 'openai-compatible');
}

function readAgentTokenDemoConfig() {
  return {
    inputPricePerMillion: readOptionalNumberEnv(`${agentDefinition.modelEnvPrefix}_INPUT_PRICE_PER_1M`),
    outputPricePerMillion: readOptionalNumberEnv(`${agentDefinition.modelEnvPrefix}_OUTPUT_PRICE_PER_1M`),
    priceCurrency: readOptionalTextEnv(`${agentDefinition.modelEnvPrefix}_PRICE_CURRENCY`) ?? readOptionalTextEnv('PRICE_CURRENCY') ?? 'USD',
    maxContextTokens:
      readOptionalNumberEnv(`${agentDefinition.modelEnvPrefix}_MAX_CONTEXT_TOKENS`) ??
      readOptionalNumberEnv('MODEL_MAX_CONTEXT_TOKENS') ??
      agentDefinition.maxContextTokens,
    reservedOutputTokens:
      readOptionalNumberEnv(`${agentDefinition.modelEnvPrefix}_RESERVED_OUTPUT_TOKENS`) ??
      readOptionalNumberEnv('MODEL_RESERVED_OUTPUT_TOKENS') ??
      agentDefinition.reservedOutputTokens
  };
}

const defaultTask =
  readOptionalTextEnv('DEFAULT_TASK') ??
  'Объясни простыми словами, что такое градиентный бустинг, и приведи один пример применения.';
const agentDataPath = path.resolve(__dirname, '../data');
const agentSessionsPath = path.join(agentDataPath, 'agent-sessions');
const defaultAgentSessionId = 'main';

app.use(cors());
app.use(express.json({ limit: '64kb' }));

function readCompareRequest(body: unknown): CompareRequest | string {
  if (!body || typeof body !== 'object') return 'Request body is required.';

  const candidate = body as Record<string, unknown>;
  const task = typeof candidate.task === 'string' ? candidate.task.trim() : '';

  if (!task) return 'Task is required.';

  return { task };
}

function readAgentRequest(body: unknown): AgentRequest | string {
  if (!body || typeof body !== 'object') return 'Request body is required.';

  const candidate = body as Record<string, unknown>;
  const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
  const rawSessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined;

  if (!message) return 'Message is required.';

  return { message, sessionId: normalizeSessionId(rawSessionId) };
}

function buildChatCompletionsUrl(baseUrl: string) {
  if (baseUrl.endsWith('/chat/completions')) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

async function requestCompletion(
  config: ModelConfig,
  messages: AgentMessage[],
  options?: { temperature?: number }
): Promise<CompletionResult> {
  if (config.provider === 'gemini') {
    return requestGeminiCompletion(config, messages, options);
  }

  return requestOpenAiCompatibleCompletion(config, messages, options);
}

async function requestOpenAiCompatibleCompletion(
  config: ModelConfig,
  messages: AgentMessage[],
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

  const estimatedInputTokens = estimateMessagesTokens(messages);
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
  messages: AgentMessage[],
  options?: { temperature?: number }
): Promise<CompletionResult> {
  const text = messages.map((message) => `${message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User'}: ${message.content}`).join('\n\n');
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

  const inputTokens = data.usageMetadata?.promptTokenCount ?? estimateMessagesTokens(messages);
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
    priceCurrency: config.priceCurrency,
    maxContextTokens: config.maxContextTokens,
    reservedOutputTokens: config.reservedOutputTokens
  };
}

function toPublicAgentMessage(
  message: Awaited<ReturnType<SimpleAgent['history']>>[number],
  tokenMeta?: PublicRequestTokenMeta,
  responseMeta?: PublicResponseTokenMeta
): PublicAgentMessage {
  return {
    id: message.id,
    role: message.role === 'assistant' ? 'agent' : 'user',
    content: message.content,
    createdAt: message.createdAt,
    tokenMeta,
    responseMeta
  };
}

function normalizeSessionId(value: string | null | undefined) {
  const normalized = (value ?? defaultAgentSessionId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
  return normalized || defaultAgentSessionId;
}

function readSessionIdFromRequest(req: Request) {
  return normalizeSessionId(typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined);
}

function createSessionTitle(sessionId: string) {
  if (sessionId === defaultAgentSessionId) return 'Главное окно';
  return `Окно ${sessionId.slice(0, 8)}`;
}

function createChatTitle(history: Awaited<ReturnType<SimpleAgent['history']>>, sessionId: string) {
  const firstUserMessage = history.find((message) => message.role === 'user');
  if (!firstUserMessage) return createSessionTitle(sessionId);

  const compactTitle = firstUserMessage.content.replace(/\s+/g, ' ').trim().slice(0, 42);
  return compactTitle || createSessionTitle(sessionId);
}

function createLastMessagePreview(history: Awaited<ReturnType<SimpleAgent['history']>>) {
  const lastMessage = history[history.length - 1];
  if (!lastMessage) return null;
  return lastMessage.content.replace(/\s+/g, ' ').trim().slice(0, 86) || null;
}

function getChatUpdatedAt(history: Awaited<ReturnType<SimpleAgent['history']>>) {
  return history[history.length - 1]?.createdAt ?? null;
}

function createAgentConversationStore(sessionId: string) {
  return new JsonConversationStore(path.join(agentSessionsPath, `${sessionId}.json`));
}

function createTokenPricing(agentModel: ModelConfig) {
  return {
    inputPricePerMillion: agentModel.inputPricePerMillion,
    outputPricePerMillion: agentModel.outputPricePerMillion,
    priceCurrency: agentModel.priceCurrency
  };
}

function createTokenBudget(agentModel: ModelConfig) {
  return normalizeTokenBudget({
    maxContextTokens: agentModel.maxContextTokens,
    reservedOutputTokens: agentModel.reservedOutputTokens
  });
}

function createPublicRequestTokenMeta(
  historyBeforeRequest: Awaited<ReturnType<SimpleAgent['history']>>,
  requestContent: string,
  agentModel: ModelConfig
): PublicRequestTokenMeta {
  const tokenBudget = createTokenBudget(agentModel);
  const selectedHistory = selectMessagesForTokenReport(historyBeforeRequest, requestContent, tokenBudget);
  const report = createTokenReport({
    systemPrompt: agentDefinition.systemPrompt,
    selectedHistory,
    fullHistory: historyBeforeRequest,
    currentRequest: requestContent,
    pricing: createTokenPricing(agentModel),
    budget: tokenBudget
  });

  return {
    currentRequestTokens: report.currentRequestTokens,
    fullHistoryTokens: report.fullHistoryTokens,
    selectedHistoryTokens: report.selectedHistoryTokens,
    inputTokens: report.inputTokens,
    maxContextTokens: report.maxContextTokens,
    remainingInputTokens: Math.max(0, report.availableInputTokens - report.inputTokens),
    priceCurrency: report.priceCurrency,
    estimatedInputCost: report.estimatedInputCost
  };
}

function createPublicResponseTokenMeta(
  responseContent: string,
  requestTokenMeta: PublicRequestTokenMeta | undefined,
  agentModel: ModelConfig
): PublicResponseTokenMeta {
  const outputTokens = estimateTokens(responseContent);
  const totalTokens = requestTokenMeta ? requestTokenMeta.inputTokens + outputTokens : null;
  const estimatedOutputCost =
    agentModel.outputPricePerMillion === null ? null : (outputTokens / 1_000_000) * agentModel.outputPricePerMillion;
  const estimatedTotalCost =
    requestTokenMeta?.estimatedInputCost === null || requestTokenMeta?.estimatedInputCost === undefined || estimatedOutputCost === null
      ? null
      : requestTokenMeta.estimatedInputCost + estimatedOutputCost;

  return {
    outputTokens,
    totalTokens,
    priceCurrency: agentModel.priceCurrency,
    estimatedOutputCost,
    estimatedTotalCost
  };
}

function selectMessagesForTokenReport(
  historyBeforeRequest: Awaited<ReturnType<SimpleAgent['history']>>,
  requestContent: string,
  tokenBudget: ReturnType<typeof createTokenBudget>
) {
  const maxContextMessages = readOptionalNumberEnv('AGENT_MAX_CONTEXT_MESSAGES') ?? 40;
  const maxContextCharacters = readOptionalNumberEnv('AGENT_MAX_CONTEXT_CHARACTERS') ?? 24_000;
  const recentMessages = historyBeforeRequest.slice(-maxContextMessages);
  const selectedMessages: Awaited<ReturnType<SimpleAgent['history']>> = [];
  const maxInputTokens = Math.max(0, tokenBudget.maxContextTokens - tokenBudget.reservedOutputTokens);
  let characterCount = requestContent.length;
  let tokenCount =
    estimateMessageTokens({ role: 'system', content: agentDefinition.systemPrompt }) +
    estimateMessageTokens({ role: 'user', content: requestContent });

  for (const message of [...recentMessages].reverse()) {
    const nextCharacterCount = characterCount + message.content.length;
    const nextTokenCount = tokenCount + estimateMessageTokens({ role: message.role, content: message.content });

    if (nextTokenCount > maxInputTokens || (selectedMessages.length > 0 && nextCharacterCount > maxContextCharacters)) break;

    selectedMessages.unshift(message);
    characterCount = nextCharacterCount;
    tokenCount = nextTokenCount;
  }

  return selectedMessages;
}

function toPublicAgentMessages(history: Awaited<ReturnType<SimpleAgent['history']>>, agentModel: ModelConfig) {
  const historyBeforeMessage: Awaited<ReturnType<SimpleAgent['history']>> = [];
  let previousRequestTokenMeta: PublicRequestTokenMeta | undefined;

  return history.map((message) => {
    const tokenMeta =
      message.role === 'user' ? createPublicRequestTokenMeta(historyBeforeMessage, message.content, agentModel) : undefined;
    const responseMeta =
      message.role === 'assistant' ? createPublicResponseTokenMeta(message.content, previousRequestTokenMeta, agentModel) : undefined;
    const publicMessage = toPublicAgentMessage(message, tokenMeta, responseMeta);

    if (tokenMeta) previousRequestTokenMeta = tokenMeta;
    historyBeforeMessage.push(message);
    return publicMessage;
  });
}

function createHistoryResponse(agent: SimpleAgent, agentModel: ModelConfig, sessionId: string) {
  return agent.history().then((history) => ({
    session: {
      sessionId,
      title: createChatTitle(history, sessionId)
    } satisfies PublicAgentWindow,
    messages: toPublicAgentMessages(history, agentModel),
    stats: createHistoryTokenStats({
      history,
      pricing: createTokenPricing(agentModel),
      budget: createTokenBudget(agentModel)
    })
  }));
}

async function listAgentChats(agentModel: ModelConfig): Promise<PublicAgentChat[]> {
  let fileNames: string[];

  try {
    fileNames = await readdir(agentSessionsPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const chatCandidates = fileNames
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => normalizeSessionId(fileName.slice(0, -'.json'.length)));

  const uniqueSessionIds = [...new Set(chatCandidates)];
  const chats = await Promise.all(
    uniqueSessionIds.map(async (sessionId): Promise<PublicAgentChat | null> => {
      const agent = createAgent(agentModel, sessionId);
      const history = await agent.history();

      if (history.length === 0) return null;

      const stats = createHistoryTokenStats({
        history,
        pricing: createTokenPricing(agentModel),
        budget: createTokenBudget(agentModel)
      });

      return {
        sessionId,
        title: createChatTitle(history, sessionId),
        messageCount: stats.messageCount,
        fullHistoryTokens: stats.fullHistoryTokens,
        updatedAt: getChatUpdatedAt(history),
        lastMessagePreview: createLastMessagePreview(history)
      };
    })
  );

  return chats
    .filter((chat): chat is PublicAgentChat => chat !== null)
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
}

function createAgent(agentModel: ModelConfig, sessionId: string) {
  return new SimpleAgent({
    name: 'Simple LLM Agent',
    provider: agentDefinition.provider,
    systemPrompt: agentDefinition.systemPrompt,
    temperature: agentDefinition.temperature,
    modelTitle: agentModel.title,
    model: agentModel.model,
    conversationStore: createAgentConversationStore(sessionId),
    tokenPricing: createTokenPricing(agentModel),
    tokenBudget: createTokenBudget(agentModel),
    maxContextMessages: readOptionalNumberEnv('AGENT_MAX_CONTEXT_MESSAGES') ?? undefined,
    maxContextCharacters: readOptionalNumberEnv('AGENT_MAX_CONTEXT_CHARACTERS') ?? undefined,
    complete: (messages, options) => requestCompletion(agentModel, messages, options)
  });
}

app.get('/api/config', (_req: Request, res: Response) => {
  try {
    const agentModel = readAgentModelConfig();

    return res.json({
      defaults: { task: defaultTask },
      models: [toPublicModelConfig(agentModel)],
      hasApiKey: Boolean(agentModel.apiKey)
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

app.get('/api/agent/history', async (req: Request, res: Response) => {
  let agentModel: ModelConfig;
  try {
    agentModel = readAgentModelConfig();
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Model configuration is incomplete.'
    });
  }

  try {
    const sessionId = readSessionIdFromRequest(req);
    const agent = createAgent(agentModel, sessionId);
    return res.json(await createHistoryResponse(agent, agentModel, sessionId));
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to load agent history.'
    });
  }
});

app.get('/api/agent/chats', async (_req: Request, res: Response) => {
  let agentModel: ModelConfig;
  try {
    agentModel = readAgentModelConfig();
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Model configuration is incomplete.'
    });
  }

  try {
    return res.json({ chats: await listAgentChats(agentModel) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list agent chats.'
    });
  }
});

app.delete('/api/agent/chats/:sessionId', async (req: Request, res: Response) => {
  const rawSessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  const sessionId = normalizeSessionId(rawSessionId);

  try {
    await rm(path.join(agentSessionsPath, `${sessionId}.json`), { force: true });
    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to delete agent chat.'
    });
  }
});

app.get('/api/agent/token-demo', (_req: Request, res: Response) => {
  try {
    const tokenDemoConfig = readAgentTokenDemoConfig();

    return res.json({
      budget: {
        maxContextTokens: tokenDemoConfig.maxContextTokens,
        reservedOutputTokens: tokenDemoConfig.reservedOutputTokens,
        availableInputTokens: Math.max(0, tokenDemoConfig.maxContextTokens - tokenDemoConfig.reservedOutputTokens)
      },
      priceCurrency: tokenDemoConfig.priceCurrency,
      inputPricePerMillion: tokenDemoConfig.inputPricePerMillion,
      outputPricePerMillion: tokenDemoConfig.outputPricePerMillion,
      scenarios: buildTokenDemo(
        {
          inputPricePerMillion: tokenDemoConfig.inputPricePerMillion,
          outputPricePerMillion: tokenDemoConfig.outputPricePerMillion,
          priceCurrency: tokenDemoConfig.priceCurrency
        },
        {
          maxContextTokens: tokenDemoConfig.maxContextTokens,
          reservedOutputTokens: tokenDemoConfig.reservedOutputTokens
        }
      )
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Token demo configuration is incomplete.'
    });
  }
});

app.delete('/api/agent/history', async (req: Request, res: Response) => {
  let agentModel: ModelConfig;
  try {
    agentModel = readAgentModelConfig();
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Model configuration is incomplete.'
    });
  }

  try {
    const sessionId = readSessionIdFromRequest(req);
    const agent = createAgent(agentModel, sessionId);
    await agent.clearHistory();
    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to clear agent history.'
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
    if (error instanceof AgentContextOverflowError) {
      return res.status(400).json({
        error: error.message,
        tokenReport: error.tokenReport
      });
    }

    return res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to contact model API.'
    });
  }
});

app.post('/api/agent', async (req: Request, res: Response) => {
  const request = readAgentRequest(req.body);

  if (typeof request === 'string') {
    return res.status(400).json({ error: request });
  }

  let agentModel: ModelConfig;
  try {
    agentModel = readAgentModelConfig();
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Model configuration is incomplete.'
    });
  }

  const sessionId = normalizeSessionId(request.sessionId);
  const agent = createAgent(agentModel, sessionId);

  try {
    const result = await agent.run(request.message);
    const history = await agent.history();
    return res.json({
      ...result,
      session: {
        sessionId,
        title: createChatTitle(history, sessionId)
      },
      stats: createHistoryTokenStats({
        history,
        pricing: createTokenPricing(agentModel),
        budget: createTokenBudget(agentModel)
      })
    });
  } catch (error) {
    console.error(error);
    if (error instanceof AgentContextOverflowError) {
      return res.status(400).json({
        error: error.message,
        tokenReport: error.tokenReport
      });
    }

    return res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to contact model API.'
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

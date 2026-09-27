import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  AgentContextOverflowError,
  AgentMessage,
  JsonConversationStore,
  SimpleAgent
} from './agent.js';
import { JsonAgentMemoryStore, MemoryLayer, type MemoryEvent, validateMemoryWrite } from './memory.js';
import { approveMemorySuggestion, applyMemoryPolicy, rejectMemorySuggestion } from './memory-policy.js';
import { reflectConversationMemory, workingSummaryToWrites } from './memory-reflector.js';
import { JsonPendingMemoryStore } from './pending-memory.js';
import { JsonUserProfileStore, normalizeProfileId, validateUserProfileInput, type UserProfile } from './profile.js';
import { AgentTurnLogger, listAgentLogs, readAgentLog } from './agent-log.js';
import { assessInvariantCompliance, JsonInvariantStore, validateInvariantInput } from './invariant.js';
import {
  classifyTaskCommand,
  detectTaskCommand,
  JsonTaskStateStore,
  createTaskLifecycleInvariant,
  snapshotFromWorkingMemory,
  taskToWorkingWrites,
  taskPhaseFromMemory,
  resolveTaskPhaseTransition,
  type TaskCommand,
  type TaskPhase,
  type TaskState
} from './task-state.js';
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
import { discoverMcpConnection, JsonMcpConnectionStore, McpConnectionError } from './mcp/mcp-connections.js';
import { GoogleCalendarAuth, GoogleCalendarMcpServer } from './mcp/google-calendar-mcp.js';
import { McpAgentRuntime, McpHttpClient } from './mcp/mcp-agent-runtime.js';

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
  profileId: string;
  modelId?: string;
  useWorkingMemory: boolean;
  useLongTermMemory: boolean;
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

function readOptionalBooleanEnv(name: string) {
  const value = readOptionalTextEnv(name)?.toLowerCase();
  if (!value) return null;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be a boolean value.`);
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

function readAvailableModelConfigs() {
  const definitions: Array<[(typeof modelEnvPrefixes)[number], string, ModelConfig['provider']]> = [
    ['MODEL_GEMINI', 'Слабая: Gemini 3.5 Flash-Lite', 'gemini'],
    ['MODEL_FLASH', 'Средняя: DeepSeek V4 Flash', 'openai-compatible'],
    ['MODEL_PRO', 'Сильная: DeepSeek V4 Pro', 'openai-compatible']
  ];
  return definitions.flatMap(([prefix, title, provider]) => {
    try {
      return [readModelConfig(prefix, title, provider)];
    } catch {
      return [];
    }
  });
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

const agentDataPath = path.resolve(__dirname, '../data');
const agentSessionsPath = path.join(agentDataPath, 'agent-sessions');
const workingMemoryPath = path.join(agentDataPath, 'memory', 'working');
const longTermMemoryPath = path.join(agentDataPath, 'memory', 'long-term');
const pendingMemoryPath = path.join(agentDataPath, 'memory', 'pending');
const profilesPath = path.join(agentDataPath, 'profiles');
const agentLogsPath = path.join(agentDataPath, 'agent-logs');
const tasksPath = path.join(agentDataPath, 'tasks');
const invariantsFilePath = path.join(agentDataPath, 'invariants.json');
const mcpConnectionsFilePath = path.join(agentDataPath, 'mcp-connections.json');
const googleCalendarTokenFilePath = path.join(agentDataPath, 'secrets', 'google-calendar-token.json');
const defaultProfileId = 'default';
const defaultAgentSessionId = 'main';
const invariantStore = new JsonInvariantStore(invariantsFilePath);
const mcpConnectionStore = new JsonMcpConnectionStore(mcpConnectionsFilePath);
const googleCalendarAuth = new GoogleCalendarAuth(
  googleCalendarTokenFilePath,
  readOptionalTextEnv('GOOGLE_CALENDAR_CLIENT_ID'),
  readOptionalTextEnv('GOOGLE_CALENDAR_CLIENT_SECRET'),
  readOptionalTextEnv('GOOGLE_CALENDAR_REDIRECT_URI') ?? `http://localhost:${port}/api/google-calendar/oauth/callback`
);
const googleCalendarMcpServer = new GoogleCalendarMcpServer(googleCalendarAuth);

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
  const profileId = normalizeProfileId(candidate.profileId);
  const modelId = typeof candidate.modelId === 'string' ? candidate.modelId.trim() : undefined;
  const useWorkingMemory = candidate.useWorkingMemory !== false;
  const useLongTermMemory = candidate.useLongTermMemory !== false;
  if (!message) return 'Message is required.';

  return { message, sessionId: normalizeSessionId(rawSessionId), profileId, modelId, useWorkingMemory, useLongTermMemory };
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

function readProfileIdFromRequest(req: Request) {
  return normalizeProfileId(typeof req.query.profileId === 'string' ? req.query.profileId : undefined);
}

function createSessionTitle(sessionId: string) {
  if (sessionId === defaultAgentSessionId) return 'Главное окно';
  if (sessionId.includes('-ui-')) return `UI ветка ${sessionId.slice(-8)}`;
  if (sessionId.includes('-api-')) return `API ветка ${sessionId.slice(-8)}`;
  return `Окно ${sessionId.slice(0, 8)}`;
}

function createChatTitle(history: Awaited<ReturnType<SimpleAgent['history']>>, sessionId: string) {
  const firstUserMessage = history.find((message) => message.role === 'user');
  if (!firstUserMessage) return createSessionTitle(sessionId);

  const compactTitle = firstUserMessage.content.replace(/\s+/g, ' ').trim().slice(0, 42);
  const baseTitle = compactTitle || createSessionTitle(sessionId);
  return baseTitle;
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

function createAgentMemoryStore(sessionId: string, profileId = defaultProfileId) {
  return new JsonAgentMemoryStore(
    path.join(workingMemoryPath, `${sessionId}.json`),
    path.join(longTermMemoryPath, `${normalizeProfileId(profileId)}.json`)
  );
}

const userProfileStore = new JsonUserProfileStore(profilesPath);

function createPendingMemoryStore(sessionId: string) {
  return new JsonPendingMemoryStore(path.join(pendingMemoryPath, `${sessionId}.json`));
}

function createTaskStateStore(profileId: string) {
  const normalizedProfileId = normalizeProfileId(profileId);
  return new JsonTaskStateStore(path.join(tasksPath, `${normalizedProfileId}.json`), normalizedProfileId);
}

function createInvariantStore() {
  return invariantStore;
}

function readMemoryConfidenceThreshold() {
  const value = readOptionalNumberEnv('MEMORY_CONFIDENCE_THRESHOLD') ?? 0.75;
  return Math.min(1, value);
}

function readProfileAutoSaveThreshold() {
  const value = readOptionalNumberEnv('MEMORY_PROFILE_AUTO_SAVE_THRESHOLD') ?? 0.7;
  return Math.min(1, value);
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

function createAgent(
  agentModel: ModelConfig,
  sessionId: string,
  memoryUsage?: { working: boolean; longTerm: boolean },
  userProfile?: UserProfile
) {
  const memoryStore = createAgentMemoryStore(sessionId, userProfile?.id);
  return new SimpleAgent({
    name: 'Simple LLM Agent',
    provider: agentDefinition.provider,
    systemPrompt: agentDefinition.systemPrompt,
    temperature: agentDefinition.temperature,
    modelTitle: agentModel.title,
    model: agentModel.model,
    conversationStore: createAgentConversationStore(sessionId),
    memoryStore,
    invariantStore: {
      active: async () => {
        const [configured, memory] = await Promise.all([
          createInvariantStore().active(),
          memoryStore.load()
        ]);
        return [createTaskLifecycleInvariant(taskPhaseFromMemory(memory.working)), ...configured];
      }
    },
    assessInvariantCompliance: ({ invariants, userRequest, candidateAnswer }) => assessInvariantCompliance({
      invariants,
      userRequest,
      candidateAnswer,
      complete: async (messages) => (await requestCompletion(agentModel, messages, { temperature: 0 })).answer
    }),
    userProfile,
    tokenPricing: createTokenPricing(agentModel),
    tokenBudget: createTokenBudget(agentModel),
    maxContextMessages: readOptionalNumberEnv('AGENT_MAX_CONTEXT_MESSAGES') ?? undefined,
    maxContextCharacters: readOptionalNumberEnv('AGENT_MAX_CONTEXT_CHARACTERS') ?? undefined,
    keepLastMessages: readOptionalNumberEnv('AGENT_CONTEXT_KEEP_LAST_MESSAGES') ?? 5,
    useWorkingMemory: memoryUsage?.working ?? true,
    useLongTermMemory: memoryUsage?.longTerm ?? true,
    complete: (messages, options) => requestCompletion(agentModel, messages, options),
    toolRuntime: new McpAgentRuntime(
      new McpHttpClient(`http://127.0.0.1:${port}/mcp/google-calendar`),
      (messages, options) => requestCompletion(agentModel, messages, options)
    )
  });
}

app.get('/api/config', (_req: Request, res: Response) => {
  const models = readAvailableModelConfigs();
  if (models.length > 0) {
    return res.json({
      models: models.map(toPublicModelConfig),
      hasApiKey: true
    });
  }
  return res.json({ models: [], hasApiKey: false, error: 'Не настроен API-ключ ни для одной модели.' });
});

app.post('/mcp/google-calendar', async (req: Request, res: Response) => {
  await googleCalendarMcpServer.handleHttp(req, res);
});

app.get('/api/google-calendar/status', async (_req: Request, res: Response) => {
  try {
    return res.json({
      ...(await googleCalendarAuth.status()),
      server: { name: 'google-calendar-mcp', version: '1.0.0' },
      endpoint: '/mcp/google-calendar',
      tools: googleCalendarMcpServer.listTools()
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Не удалось проверить Google Calendar.' });
  }
});

app.get('/api/google-calendar/oauth/start', (_req: Request, res: Response) => {
  try {
    return res.redirect(googleCalendarAuth.createAuthorizationUrl());
  } catch (error) {
    return res.status(400).send(error instanceof Error ? error.message : 'Google OAuth не настроен.');
  }
});

app.get('/api/google-calendar/oauth/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
  try {
    if (oauthError) throw new Error(`Google OAuth: ${oauthError}`);
    if (!code || !state) throw new Error('Google не вернул code или state.');
    await googleCalendarAuth.exchangeAuthorizationCode(code, state);
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>Google Calendar подключён</title><style>body{font:16px system-ui;max-width:620px;margin:80px auto;padding:24px;color:#162032}h1{color:#16784b}</style><h1>Google Calendar подключён</h1><p>Можно закрыть эту вкладку и вернуться к агенту.</p><script>window.opener?.postMessage({type:"google-calendar-connected"}, location.origin)</script>');
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'Ошибка Google OAuth.').replace(/[<>&"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[character] ?? character);
    return res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><title>Ошибка OAuth</title><style>body{font:16px system-ui;max-width:620px;margin:80px auto;padding:24px;color:#162032}h1{color:#b3261e}</style><h1>Не удалось подключить Google Calendar</h1><p>${message}</p>`);
  }
});

app.delete('/api/google-calendar/oauth', async (_req: Request, res: Response) => {
  try {
    await googleCalendarAuth.disconnect();
    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Не удалось отключить Google Calendar.' });
  }
});

app.get('/api/mcp/connections', async (_req: Request, res: Response) => {
  try {
    return res.json({ connections: await mcpConnectionStore.list() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Не удалось загрузить MCP-подключения.' });
  }
});

app.post('/api/mcp/connections', async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const headerName = typeof body.headerName === 'string' ? body.headerName : undefined;
  const headerValue = typeof body.headerValue === 'string' ? body.headerValue : undefined;
  try {
    const discovered = await discoverMcpConnection({ endpoint, headerName, headerValue });
    return res.status(201).json({ connection: await mcpConnectionStore.save(discovered) });
  } catch (error) {
    if (error instanceof McpConnectionError) {
      return res.status(error.code === 'invalid_input' ? 400 : 502).json({ error: error.message });
    }
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Не удалось подключить MCP server.' });
  }
});

app.delete('/api/mcp/connections/:id', async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    return await mcpConnectionStore.remove(id)
      ? res.status(204).send()
      : res.status(404).json({ error: 'MCP connection not found.' });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Не удалось удалить MCP-подключение.' });
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

app.get('/api/profiles', async (_req: Request, res: Response) => {
  try {
    return res.json({ profiles: await userProfileStore.list() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load profiles.' });
  }
});

app.post('/api/profiles', async (req: Request, res: Response) => {
  const input = validateUserProfileInput(req.body);
  if (typeof input === 'string') return res.status(400).json({ error: input });
  try {
    return res.status(201).json({ profile: await userProfileStore.save(input) });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save profile.' });
  }
});

app.put('/api/profiles/:id', async (req: Request, res: Response) => {
  const input = validateUserProfileInput(req.body);
  if (typeof input === 'string') return res.status(400).json({ error: input });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    return res.json({ profile: await userProfileStore.save(input, id) });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update profile.' });
  }
});

app.delete('/api/profiles/:id', async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    await userProfileStore.remove(id);
    return res.status(204).send();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete profile.';
    return res.status(message.includes('Default') ? 400 : 500).json({ error: message });
  }
});

app.get('/api/invariants', async (_req: Request, res: Response) => {
  try {
    return res.json({
      scope: 'all-dialogues',
      storage: 'invariants.json',
      invariants: await createInvariantStore().list()
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load invariants.' });
  }
});

app.post('/api/invariants', async (req: Request, res: Response) => {
  const input = validateInvariantInput(req.body);
  if (typeof input === 'string') return res.status(400).json({ error: input });
  try {
    return res.status(201).json({ invariant: await createInvariantStore().save(input) });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save invariant.' });
  }
});

app.put('/api/invariants/:id', async (req: Request, res: Response) => {
  const input = validateInvariantInput(req.body);
  if (typeof input === 'string') return res.status(400).json({ error: input });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    return res.json({ invariant: await createInvariantStore().save(input, id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update invariant.';
    return res.status(message === 'Invariant not found.' ? 404 : 500).json({ error: message });
  }
});

app.delete('/api/invariants/:id', async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const removed = await createInvariantStore().remove(id);
    return removed ? res.status(204).send() : res.status(404).json({ error: 'Invariant not found.' });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete invariant.' });
  }
});

app.get('/api/agent/memory', async (req: Request, res: Response) => {
  const sessionId = readSessionIdFromRequest(req);
  const profileId = readProfileIdFromRequest(req);

  try {
    const [snapshot, shortTerm] = await Promise.all([
      createAgentMemoryStore(sessionId, profileId).load(),
      createAgentConversationStore(sessionId).load()
    ]);
    return res.json({
      sessionId,
      layers: {
        shortTerm: {
          scope: 'current-dialogue',
          storage: `agent-sessions/${sessionId}.json`,
          messages: shortTerm
        },
        working: {
          scope: 'current-task',
          storage: `memory/working/${sessionId}.json`,
          entries: snapshot.working
        },
        longTerm: {
          scope: 'all-dialogues',
          profileId,
          storage: `memory/long-term/${profileId}.json`,
          entries: snapshot.longTerm
        }
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load memory.' });
  }
});

app.post('/api/agent/memory', async (req: Request, res: Response) => {
  const write = validateMemoryWrite(req.body);
  if (typeof write === 'string') return res.status(400).json({ error: write });
  const sessionId = normalizeSessionId(typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined);
  const profileId = normalizeProfileId(req.body?.profileId);

  try {
    const entry = await createAgentMemoryStore(sessionId, profileId).upsert({ ...write, source: 'manual' });
    return res.status(201).json({ entry, explicit: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save memory.' });
  }
});

app.delete('/api/agent/memory/:layer/:id', async (req: Request, res: Response) => {
  const layer = (Array.isArray(req.params.layer) ? req.params.layer[0] : req.params.layer) as MemoryLayer;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (layer !== 'working' && layer !== 'long-term') return res.status(400).json({ error: 'Invalid memory layer.' });
  const sessionId = readSessionIdFromRequest(req);
  const profileId = readProfileIdFromRequest(req);

  try {
    await createAgentMemoryStore(sessionId, profileId).remove(layer, id);
    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete memory.' });
  }
});

app.get('/api/agent/memory/pending', async (req: Request, res: Response) => {
  const sessionId = readSessionIdFromRequest(req);
  const profileId = readProfileIdFromRequest(req);
  try {
    const suggestions = (await createPendingMemoryStore(sessionId).list()).filter((suggestion) => suggestion.profileId === profileId);
    return res.json({ sessionId, profileId, suggestions });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load pending memory.' });
  }
});

app.get('/api/tasks', async (req: Request, res: Response) => {
  const profileId = readProfileIdFromRequest(req);
  try {
    return res.json({ profileId, tasks: await createTaskStateStore(profileId).list() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load tasks.' });
  }
});

app.post('/api/tasks/:id/resume', async (req: Request, res: Response) => {
  const profileId = normalizeProfileId(req.body?.profileId);
  const sessionId = normalizeSessionId(typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const task = await createTaskStateStore(profileId).resume(id, sessionId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена или уже завершена.' });
    await createAgentMemoryStore(sessionId, profileId).replaceAgentWorking(taskToWorkingWrites(task));
    return res.json({ task });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to resume task.' });
  }
});

app.post('/api/tasks/:id/pause', async (req: Request, res: Response) => {
  const profileId = normalizeProfileId(req.body?.profileId);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const task = await createTaskStateStore(profileId).pauseExisting(id);
    if (!task) return res.status(404).json({ error: 'Активная задача не найдена.' });
    return res.json({ task });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to pause task.' });
  }
});

app.delete('/api/tasks/:id', async (req: Request, res: Response) => {
  const profileId = readProfileIdFromRequest(req);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    await createTaskStateStore(profileId).remove(id);
    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete task.' });
  }
});

app.post('/api/agent/memory/pending/:id/approve', async (req: Request, res: Response) => {
  const sessionId = normalizeSessionId(typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const logger = new AgentTurnLogger(agentLogsPath, sessionId);
  try {
    const pendingStore = createPendingMemoryStore(sessionId);
    const suggestion = (await pendingStore.list()).find((item) => item.id === id);
    if (!suggestion) return res.status(404).json({ error: 'Pending memory suggestion not found.' });
    const event = await logger.step('memory_persist', () =>
      approveMemorySuggestion(id, createAgentMemoryStore(sessionId, suggestion.profileId), pendingStore)
    );
    if (!event) return res.status(404).json({ error: 'Pending memory suggestion not found.' });
    await logger.annotate('memory_persist', { memoryEvents: [event] });
    return res.json({ event, turnId: logger.turnId });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to approve memory.' });
  }
});

app.post('/api/agent/memory/pending/:id/reject', async (req: Request, res: Response) => {
  const sessionId = normalizeSessionId(typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const logger = new AgentTurnLogger(agentLogsPath, sessionId);
  try {
    const event = await logger.step('memory_persist', () => rejectMemorySuggestion(id, createPendingMemoryStore(sessionId)));
    if (!event) return res.status(404).json({ error: 'Pending memory suggestion not found.' });
    await logger.annotate('memory_persist', { memoryEvents: [event] });
    return res.json({ event, turnId: logger.turnId });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reject memory.' });
  }
});

app.get('/api/agent/logs', async (req: Request, res: Response) => {
  const sessionId = readSessionIdFromRequest(req);
  try {
    return res.json({ sessionId, logs: await listAgentLogs(agentLogsPath, sessionId) });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load agent logs.' });
  }
});

app.get('/api/agent/logs/:turnId', async (req: Request, res: Response) => {
  const sessionId = readSessionIdFromRequest(req);
  const turnId = Array.isArray(req.params.turnId) ? req.params.turnId[0] : req.params.turnId;
  if (!/^turn-[a-zA-Z0-9-]+$/.test(turnId)) return res.status(400).json({ error: 'Invalid turnId.' });
  try {
    const log = await readAgentLog(agentLogsPath, sessionId, turnId);
    return log ? res.json(log) : res.status(404).json({ error: 'Agent log not found.' });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load agent log.' });
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
    await rm(path.join(workingMemoryPath, `${sessionId}.json`), { force: true });
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
    await Promise.all([
      agent.clearHistory(),
      createAgentMemoryStore(sessionId).clearWorking(),
      createPendingMemoryStore(sessionId).clear()
    ]);
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

  const availableModels = readAvailableModelConfigs();
  const defaultModelId = agentDefinition.modelEnvPrefix.toLowerCase().replace('model_', '');
  const agentModel = request.modelId
    ? availableModels.find((model) => model.id === request.modelId)
    : availableModels.find((model) => model.id === defaultModelId) ?? availableModels[0];
  if (!agentModel) {
    return res.status(request.modelId ? 400 : 500).json({
      error: request.modelId ? `Модель ${request.modelId} недоступна или не настроена.` : 'Не настроена ни одна модель.'
    });
  }

  const sessionId = normalizeSessionId(request.sessionId);
  const userProfile = await userProfileStore.get(request.profileId);
  if (!userProfile) {
    return res.status(400).json({ error: `Профиль ${request.profileId} не найден.` });
  }
  const agent = createAgent(agentModel, sessionId, {
    working: request.useWorkingMemory,
    longTerm: request.useLongTermMemory
  }, userProfile);
  const logger = new AgentTurnLogger(agentLogsPath, sessionId);

  try {
    const taskStore = createTaskStateStore(request.profileId);
    let [memoryBeforeTaskCommand, historyBeforeTaskCommand, savedTasks] = await Promise.all([
      createAgentMemoryStore(sessionId, request.profileId).load(),
      createAgentConversationStore(sessionId).load(),
      taskStore.list()
    ]);
    const sessionHasActiveTask = savedTasks.some((task) => task.status === 'active' && task.activeSessionId === sessionId);
    if (historyBeforeTaskCommand.length === 0 && !sessionHasActiveTask && memoryBeforeTaskCommand.working.length > 0) {
      await createAgentMemoryStore(sessionId, request.profileId).clearWorking();
      memoryBeforeTaskCommand = await createAgentMemoryStore(sessionId, request.profileId).load();
    }
    let taskCommand: TaskCommand;
    try {
      taskCommand = await logger.step('task_intent_classification', () => classifyTaskCommand({
        message: request.message,
        workingMemory: memoryBeforeTaskCommand.working,
        recentHistory: historyBeforeTaskCommand.map(({ role, content }) => ({ role, content })),
        savedTasks,
        complete: async (messages) => (await requestCompletion(agentModel, messages, { temperature: 0 })).answer
      }), { provider: agentDefinition.provider, model: agentModel.model });
    } catch {
      taskCommand = detectTaskCommand(request.message);
    }
    let resumedTask: TaskState | null = null;
    if (taskCommand.type === 'resume') {
      const taskToResume = taskCommand.taskId
        ? savedTasks.find((task) => task.id === taskCommand.taskId && task.status !== 'done') ?? null
        : await taskStore.findForResume(taskCommand.latest ? null : taskCommand.query);
      if (!taskToResume) {
        return res.status(404).json({
          error: taskCommand.query
            ? `Не нашёл сохранённую задачу «${taskCommand.query}».`
            : 'У этого пользователя пока нет незавершённых сохранённых задач.'
        });
      }
      resumedTask = await taskStore.resume(taskToResume.id, sessionId);
      if (resumedTask) {
        await createAgentMemoryStore(sessionId, request.profileId).replaceAgentWorking(taskToWorkingWrites(resumedTask));
      }
    }
    const loadedMemory = await logger.step('memory_load', () => createAgentMemoryStore(sessionId, request.profileId).load());
    await logger.step('context_assembly', async () => { await agent.inspectNextRun(request.message); });
    const result = await logger.step('provider_request', () => agent.run(request.message), {
      provider: agentDefinition.provider,
      model: agentModel.model
    });
    await logger.step('invariant_check', async () => result.invariantCompliance ?? null, {
      invariantCompliance: result.invariantCompliance
    });
    await logger.annotate('provider_request', {
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined
    });
    await logger.step('conversation_persist', async () => undefined);
    const history = await agent.history();
    let reflection: Awaited<ReturnType<typeof reflectConversationMemory>> | null = null;
    let requestedTaskPhase: TaskPhase | null = null;
    try {
      reflection = await logger.step('memory_classification', () => reflectConversationMemory({
        history,
        previousMemory: loadedMemory,
        userMessage: request.message,
        assistantAnswer: result.answer,
        complete: async (messages) => (await requestCompletion(agentModel, messages, { temperature: 0 })).answer
      }), { provider: agentDefinition.provider, model: agentModel.model });
    } catch {
      reflection = null;
    }
    if (reflection) {
      const previousStageValue = loadedMemory.working.find((entry) => entry.key === 'task.stage')?.value;
      const previousStage: TaskPhase = previousStageValue === 'execution' || previousStageValue === 'validation' || previousStageValue === 'done'
        ? previousStageValue
        : 'planning';
      requestedTaskPhase = reflection.working.stage;
      const phaseTransition = resolveTaskPhaseTransition(
        previousStage,
        reflection.working.stage,
        reflection.working.validationPassed,
        reflection.working.planApproved
      );
      reflection.working.stage = phaseTransition.phase;
      if (!phaseTransition.allowed) {
        reflection.working.state = loadedMemory.working.find((entry) => entry.key === 'task.state')?.value
          ?? reflection.working.state;
        reflection.working.currentStep = loadedMemory.working.find((entry) => entry.key === 'task.current_step')?.value
          ?? reflection.working.currentStep;
        reflection.working.expectedAction = loadedMemory.working.find((entry) => entry.key === 'task.expected_action')?.value
          ?? phaseTransition.rejectionReason
          ?? reflection.working.expectedAction;
        reflection.working.validationPassed = false;
        reflection.working.validationSummary = loadedMemory.working.find((entry) => entry.key === 'task.validation')?.value ?? '';
      }
    }
    const workingWrites = reflection ? workingSummaryToWrites(reflection.working) : [];
    const policyEvents = await logger.step('memory_policy', () => applyMemoryPolicy(reflection?.longTermCandidates ?? [], {
      sessionId,
      profileId: request.profileId,
      confidenceThreshold: readMemoryConfidenceThreshold(),
      longTermAutoSaveThreshold: readProfileAutoSaveThreshold(),
      memoryStore: createAgentMemoryStore(sessionId, request.profileId),
      pendingStore: createPendingMemoryStore(sessionId),
      taskContextValues: workingWrites.map((write) => write.value)
    }));
    await logger.annotate('memory_policy', { memoryEvents: policyEvents });
    const workingEvent: MemoryEvent | null = reflection ? {
      type: 'updated', scope: 'working', reason: 'Сжатый контекст текущей задачи обновлён.', createdAt: new Date().toISOString()
    } : null;
    await logger.step('memory_persist', async () => {
      if (reflection) await createAgentMemoryStore(sessionId, request.profileId).replaceAgentWorking(workingWrites);
    }, { memoryEvents: workingEvent ? [workingEvent, ...policyEvents] : policyEvents });
    let taskState: TaskState | null = resumedTask;
    const snapshot = reflection ? {
      goal: reflection.working.goal,
      constraints: reflection.working.constraints,
      decisions: reflection.working.decisions,
      artifacts: reflection.working.artifacts,
      nextSteps: reflection.working.nextSteps
    } : snapshotFromWorkingMemory(loadedMemory.working);
    const phase: TaskPhase = reflection?.working.stage
      ?? (loadedMemory.working.find((entry) => entry.key === 'task.stage')?.value as TaskPhase | undefined)
      ?? 'planning';
    const currentStep = reflection?.working.currentStep
      || loadedMemory.working.find((entry) => entry.key === 'task.current_step')?.value
      || reflection?.working.state
      || 'Продолжить работу над задачей';
    const expectedAction = reflection?.working.expectedAction
      || loadedMemory.working.find((entry) => entry.key === 'task.expected_action')?.value
      || snapshot.nextSteps[0]
      || 'Определить следующий шаг';
    if (taskCommand.type === 'pause') {
      taskState = await taskStore.pause({
        title: taskCommand.query || snapshot.goal.slice(0, 100) || `Задача ${new Date().toLocaleDateString('ru-RU')}`,
        phase,
        currentStep,
        expectedAction,
        sourceSessionId: sessionId,
        snapshot
      });
    } else {
      const activeTask = resumedTask ?? await taskStore.findActiveForSession(sessionId);
      if (activeTask && reflection) {
        taskState = await taskStore.updateProgress(activeTask.id, {
          phase: requestedTaskPhase ?? phase,
          currentStep,
          expectedAction,
          snapshot,
          planApproved: reflection.working.planApproved,
          validationPassed: reflection.working.validationPassed,
          validationSummary: reflection.working.validationSummary
        });
      }
    }
    const memoryEvents = workingEvent ? [workingEvent, ...policyEvents] : policyEvents;
    return res.json({
      ...result,
      turnId: logger.turnId,
      memoryReflection: reflection,
      memoryEvents,
      profile: userProfile,
      task: taskState,
      taskCommand: taskCommand.type,
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

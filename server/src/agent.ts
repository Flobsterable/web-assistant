import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTokenReport, TokenBudget, TokenPricing } from './token-meter.js';
import {
  createTokenReport,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  normalizeTokenBudget
} from './token-meter.js';

export type AgentMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type StoredAgentMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type ConversationSummary = {
  id: string;
  startMessageId: string;
  endMessageId: string;
  messageCount: number;
  content: string;
  createdAt: string;
};

export type ConversationCompressionReport = {
  enabled: boolean;
  keepLastMessages: number;
  summaryBatchMessages: number;
  fullHistoryMessages: number;
  exactHistoryMessages: number;
  summarizedMessages: number;
  summaryCount: number;
  fullHistoryTokens: number;
  compressedHistoryTokens: number;
  uncompressedInputTokens: number;
  compressedInputTokens: number;
  savedInputTokens: number;
  savedInputPercent: number;
  summarizationInputTokens: number;
  summarizationOutputTokens: number;
};

export type AgentCompletionResult = {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated';
  tokenReport?: AgentTokenReport;
  compression?: ConversationCompressionReport;
  cost: number | null;
  priceCurrency: string;
  elapsedMs: number;
  finishReason: string | null;
};

export type AgentRunResult = AgentCompletionResult & {
  agentName: string;
  agentProvider: string;
  modelTitle: string;
  model: string;
};

export class AgentContextOverflowError extends Error {
  constructor(
    message: string,
    readonly tokenReport: AgentTokenReport
  ) {
    super(message);
    this.name = 'AgentContextOverflowError';
  }
}

type CompletionClient = (messages: AgentMessage[], options?: { temperature?: number }) => Promise<AgentCompletionResult>;

type ConversationStore = {
  load: () => Promise<StoredAgentMessage[]>;
  loadSummaries: () => Promise<ConversationSummary[]>;
  replaceSummaries: (summaries: ConversationSummary[]) => Promise<void>;
  appendMany: (messages: Array<Omit<StoredAgentMessage, 'id' | 'createdAt'>>) => Promise<StoredAgentMessage[]>;
  clear: () => Promise<void>;
};

type SimpleAgentOptions = {
  name: string;
  provider: string;
  systemPrompt: string;
  temperature: number;
  modelTitle: string;
  model: string;
  complete: CompletionClient;
  conversationStore: ConversationStore;
  tokenPricing: TokenPricing;
  tokenBudget?: Partial<TokenBudget>;
  maxContextMessages?: number;
  maxContextCharacters?: number;
  compression?: {
    enabled?: boolean;
    keepLastMessages?: number;
    summaryBatchMessages?: number;
  };
};

type PersistedConversation = {
  messages: StoredAgentMessage[];
  summaries?: ConversationSummary[];
};

type PreparedContext = {
  messages: AgentMessage[];
  exactMessages: StoredAgentMessage[];
  summaries: ConversationSummary[];
  report: ConversationCompressionReport;
};

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isStoredAgentMessage(value: unknown): value is StoredAgentMessage {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === 'string' &&
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string' &&
    typeof candidate.createdAt === 'string'
  );
}

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.startMessageId === 'string' &&
    typeof candidate.endMessageId === 'string' &&
    typeof candidate.messageCount === 'number' &&
    typeof candidate.content === 'string' &&
    typeof candidate.createdAt === 'string'
  );
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

export class JsonConversationStore implements ConversationStore {
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxStoredMessages = 400
  ) {}

  async load() {
    return (await this.loadPersisted()).messages;
  }

  async loadSummaries() {
    return (await this.loadPersisted()).summaries ?? [];
  }

  async replaceSummaries(summaries: ConversationSummary[]) {
    await this.enqueueWrite(async () => {
      const persisted = await this.loadPersisted();
      await this.save(persisted.messages, summaries);
    });
  }

  async appendMany(messagesToAppend: Array<Omit<StoredAgentMessage, 'id' | 'createdAt'>>) {
    return this.enqueueWrite(async () => {
      const persisted = await this.loadPersisted();
      const createdAt = new Date().toISOString();
      const nextMessages = [
        ...persisted.messages,
        ...messagesToAppend.map((message) => ({
          ...message,
          id: createMessageId(),
          createdAt
        }))
      ].slice(-this.maxStoredMessages);

      await this.save(nextMessages, persisted.summaries ?? []);
      return nextMessages;
    });
  }

  async clear() {
    await this.enqueueWrite(async () => {
      await this.save([], []);
    });
  }

  private async loadPersisted(): Promise<PersistedConversation> {
    try {
      const rawContent = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(rawContent) as Partial<PersistedConversation>;

      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isStoredAgentMessage) : [],
        summaries: Array.isArray(parsed.summaries) ? parsed.summaries.filter(isConversationSummary) : []
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { messages: [], summaries: [] };
      }
      await this.backupUnreadableFile();
      return { messages: [], summaries: [] };
    }
  }

  private async backupUnreadableFile() {
    try {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      await rename(this.filePath, backupPath);
    } catch (backupError) {
      if (backupError && typeof backupError === 'object' && 'code' in backupError && backupError.code === 'ENOENT') return;
      throw backupError;
    }
  }

  private async enqueueWrite<T>(operation: () => Promise<T>) {
    const nextOperation = this.writeQueue.then(operation, operation);
    this.writeQueue = nextOperation.then(
      () => undefined,
      () => undefined
    );
    return nextOperation;
  }

  private async save(messages: StoredAgentMessage[], summaries: ConversationSummary[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 2, messages, summaries }, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

export class SimpleAgent {
  private readonly name: string;
  private readonly provider: string;
  private readonly systemPrompt: string;
  private readonly temperature: number;
  private readonly modelTitle: string;
  private readonly model: string;
  private readonly complete: CompletionClient;
  private readonly conversationStore: ConversationStore;
  private readonly tokenPricing: TokenPricing;
  private readonly tokenBudget?: Partial<TokenBudget>;
  private readonly maxContextMessages: number;
  private readonly maxContextCharacters: number;
  private readonly compressionEnabled: boolean;
  private readonly keepLastMessages: number;
  private readonly summaryBatchMessages: number;

  constructor(options: SimpleAgentOptions) {
    this.name = options.name;
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt;
    this.temperature = options.temperature;
    this.modelTitle = options.modelTitle;
    this.model = options.model;
    this.complete = options.complete;
    this.conversationStore = options.conversationStore;
    this.tokenPricing = options.tokenPricing;
    this.tokenBudget = options.tokenBudget;
    this.maxContextMessages = normalizePositiveInteger(options.maxContextMessages, 40);
    this.maxContextCharacters = normalizePositiveInteger(options.maxContextCharacters, 24_000);
    this.compressionEnabled = options.compression?.enabled ?? true;
    this.keepLastMessages = normalizePositiveInteger(options.compression?.keepLastMessages, 5);
    this.summaryBatchMessages = normalizePositiveInteger(options.compression?.summaryBatchMessages, 5);
  }

  async history() {
    return this.conversationStore.load();
  }

  async clearHistory() {
    await this.conversationStore.clear();
  }

  async run(userRequest: string): Promise<AgentRunResult> {
    const normalizedRequest = userRequest.trim();

    if (!normalizedRequest) {
      throw new Error('User request is required.');
    }

    const fullHistory = await this.conversationStore.load();
    const preparedContext = await this.prepareContext(fullHistory, normalizedRequest);
    const initialTokenReport = createTokenReport({
      systemPrompt: this.systemPrompt,
      selectedHistory: preparedContext.messages,
      fullHistory,
      currentRequest: normalizedRequest,
      pricing: this.tokenPricing,
      budget: this.tokenBudget
    });

    if (initialTokenReport.willOverflow) {
      throw new AgentContextOverflowError(
        `Запрос не помещается в контекст модели: превышение ${initialTokenReport.overflowTokens} токенов. Сократите запрос или увеличьте MODEL_MAX_CONTEXT_TOKENS.`,
        initialTokenReport
      );
    }

    const completion = await this.complete(
      [
        {
          role: 'system',
          content: this.systemPrompt
        },
        ...preparedContext.messages,
        {
          role: 'user',
          content: normalizedRequest
        }
      ],
      { temperature: this.temperature }
    );

    await this.conversationStore.appendMany([
      {
        role: 'user',
        content: normalizedRequest
      },
      {
        role: 'assistant',
        content: completion.answer
      }
    ]);

    return {
      ...completion,
      tokenReport: createTokenReport({
        systemPrompt: this.systemPrompt,
        selectedHistory: preparedContext.messages,
        fullHistory,
        currentRequest: normalizedRequest,
        outputText: completion.answer,
        apiInputTokens: completion.inputTokens,
        apiOutputTokens: completion.outputTokens,
        apiTotalTokens: completion.totalTokens,
        tokenSource: completion.tokenSource,
        pricing: this.tokenPricing,
        budget: this.tokenBudget
      }),
      compression: preparedContext.report,
      agentName: this.name,
      agentProvider: this.provider,
      modelTitle: this.modelTitle,
      model: this.model
    };
  }

  async inspectNextRun(userRequest: string) {
    const normalizedRequest = userRequest.trim();

    if (!normalizedRequest) {
      throw new Error('User request is required.');
    }

    const fullHistory = await this.conversationStore.load();
    const preparedContext = await this.prepareContext(fullHistory, normalizedRequest);

    return createTokenReport({
      systemPrompt: this.systemPrompt,
      selectedHistory: preparedContext.messages,
      fullHistory,
      currentRequest: normalizedRequest,
      pricing: this.tokenPricing,
      budget: this.tokenBudget
    });
  }

  private async prepareContext(history: StoredAgentMessage[], nextUserMessage: string): Promise<PreparedContext> {
    if (!this.compressionEnabled) {
      const exactMessages = this.selectMessagesForContext(history, nextUserMessage);
      const messages = exactMessages.map(toAgentMessage);

      return {
        messages,
        exactMessages,
        summaries: [],
        report: this.createCompressionReport({
          fullHistory: history,
          contextMessages: messages,
          exactMessages,
          summaries: [],
          nextUserMessage,
          summarizationInputTokens: 0,
          summarizationOutputTokens: 0,
          enabled: false
        })
      };
    }

    const { summaries, summarizedMessages, summarizationInputTokens, summarizationOutputTokens } =
      await this.ensureSummaries(history);
    const exactMessages = this.selectMessagesForContext(history.slice(-this.keepLastMessages), nextUserMessage);
    const summaryMessages = summaries.map((summary): AgentMessage => ({
      role: 'assistant',
      content: [
        `Сжатая история (${summary.messageCount} сообщений, ${summary.startMessageId}..${summary.endMessageId}):`,
        summary.content
      ].join('\n')
    }));
    const contextMessages = this.trimContextMessages(
      [...summaryMessages, ...exactMessages.map(toAgentMessage)],
      nextUserMessage
    );

    return {
      messages: contextMessages,
      exactMessages,
      summaries,
      report: this.createCompressionReport({
        fullHistory: history,
        contextMessages,
        exactMessages,
        summaries,
        nextUserMessage,
        summarizationInputTokens,
        summarizationOutputTokens,
        enabled: true,
        summarizedMessages
      })
    };
  }

  private async ensureSummaries(history: StoredAgentMessage[]) {
    const existingSummaries = await this.conversationStore.loadSummaries();
    const existingById = new Map(existingSummaries.map((summary) => [summary.id, summary]));
    const summaryChunks = this.createSummaryChunks(history);
    const nextSummaries: ConversationSummary[] = [];
    let summarizationInputTokens = 0;
    let summarizationOutputTokens = 0;

    for (const chunk of summaryChunks) {
      const summaryId = createSummaryId(chunk);
      const existingSummary = existingById.get(summaryId);

      if (existingSummary) {
        nextSummaries.push(existingSummary);
        continue;
      }

      const summary = await this.summarizeChunk(chunk, summaryId);
      nextSummaries.push(summary);
      summarizationInputTokens += estimateMessagesTokens(chunk.map(toAgentMessage));
      summarizationOutputTokens += estimateTokens(summary.content);
    }

    const changed =
      nextSummaries.length !== existingSummaries.length ||
      nextSummaries.some((summary, index) => summary.id !== existingSummaries[index]?.id);

    if (changed) {
      await this.conversationStore.replaceSummaries(nextSummaries);
    }

    return {
      summaries: nextSummaries,
      summarizedMessages: summaryChunks.reduce((total, chunk) => total + chunk.length, 0),
      summarizationInputTokens,
      summarizationOutputTokens
    };
  }

  private createSummaryChunks(history: StoredAgentMessage[]) {
    const messagesToSummarize = history.slice(0, Math.max(0, history.length - this.keepLastMessages));
    const chunks: StoredAgentMessage[][] = [];

    for (let index = 0; index < messagesToSummarize.length; index += this.summaryBatchMessages) {
      chunks.push(messagesToSummarize.slice(index, index + this.summaryBatchMessages));
    }

    return chunks;
  }

  private async summarizeChunk(chunk: StoredAgentMessage[], summaryId: string): Promise<ConversationSummary> {
    const transcript = chunk
      .map((message, index) => `${index + 1}. ${message.role === 'assistant' ? 'Агент' : 'Пользователь'}: ${message.content}`)
      .join('\n\n');
    const completion = await this.complete(
      [
        {
          role: 'system',
          content:
            'Ты сжимаешь историю диалога для будущего LLM-контекста. Сохраняй факты, решения, предпочтения пользователя, ограничения, открытые вопросы и результаты. Не добавляй новых фактов.'
        },
        {
          role: 'user',
          content: `Сожми этот фрагмент истории в 5-8 коротких пунктов на русском языке:\n\n${transcript}`
        }
      ],
      { temperature: 0 }
    );

    return {
      id: summaryId,
      startMessageId: chunk[0].id,
      endMessageId: chunk[chunk.length - 1].id,
      messageCount: chunk.length,
      content: completion.answer.trim(),
      createdAt: new Date().toISOString()
    };
  }

  private selectMessagesForContext(history: StoredAgentMessage[], nextUserMessage: string) {
    const recentMessages = history.slice(-this.maxContextMessages);
    const selectedMessages: StoredAgentMessage[] = [];
    let characterCount = nextUserMessage.length;
    const tokenBudget = normalizeTokenBudget(this.tokenBudget);
    const maxInputTokens = Math.max(0, tokenBudget.maxContextTokens - tokenBudget.reservedOutputTokens);
    let tokenCount =
      estimateMessageTokens({ role: 'system', content: this.systemPrompt }) +
      estimateMessageTokens({ role: 'user', content: nextUserMessage });

    for (const message of [...recentMessages].reverse()) {
      const nextCharacterCount = characterCount + message.content.length;
      const nextTokenCount = tokenCount + estimateMessageTokens({ role: message.role, content: message.content });

      if (nextTokenCount > maxInputTokens || (selectedMessages.length > 0 && nextCharacterCount > this.maxContextCharacters)) break;

      selectedMessages.unshift(message);
      characterCount = nextCharacterCount;
      tokenCount = nextTokenCount;
    }

    return selectedMessages;
  }

  private trimContextMessages(messages: AgentMessage[], nextUserMessage: string) {
    const selectedMessages: AgentMessage[] = [];
    const tokenBudget = normalizeTokenBudget(this.tokenBudget);
    const maxInputTokens = Math.max(0, tokenBudget.maxContextTokens - tokenBudget.reservedOutputTokens);
    let tokenCount =
      estimateMessageTokens({ role: 'system', content: this.systemPrompt }) +
      estimateMessageTokens({ role: 'user', content: nextUserMessage });

    for (const message of [...messages].reverse()) {
      const nextTokenCount = tokenCount + estimateMessageTokens(message);

      if (nextTokenCount > maxInputTokens) break;

      selectedMessages.unshift(message);
      tokenCount = nextTokenCount;
    }

    return selectedMessages;
  }

  private createCompressionReport(params: {
    fullHistory: StoredAgentMessage[];
    contextMessages: AgentMessage[];
    exactMessages: StoredAgentMessage[];
    summaries: ConversationSummary[];
    nextUserMessage: string;
    summarizationInputTokens: number;
    summarizationOutputTokens: number;
    enabled: boolean;
    summarizedMessages?: number;
  }): ConversationCompressionReport {
    const systemPromptTokens = estimateMessageTokens({ role: 'system', content: this.systemPrompt });
    const currentRequestTokens = estimateMessageTokens({ role: 'user', content: params.nextUserMessage });
    const fullHistoryTokens = estimateMessagesTokens(params.fullHistory.map(toAgentMessage));
    const compressedHistoryTokens = estimateMessagesTokens(params.contextMessages);
    const uncompressedInputTokens = systemPromptTokens + fullHistoryTokens + currentRequestTokens;
    const compressedInputTokens = systemPromptTokens + compressedHistoryTokens + currentRequestTokens;
    const savedInputTokens = Math.max(0, uncompressedInputTokens - compressedInputTokens);

    return {
      enabled: params.enabled,
      keepLastMessages: this.keepLastMessages,
      summaryBatchMessages: this.summaryBatchMessages,
      fullHistoryMessages: params.fullHistory.length,
      exactHistoryMessages: params.exactMessages.length,
      summarizedMessages: params.summarizedMessages ?? 0,
      summaryCount: params.summaries.length,
      fullHistoryTokens,
      compressedHistoryTokens,
      uncompressedInputTokens,
      compressedInputTokens,
      savedInputTokens,
      savedInputPercent: uncompressedInputTokens === 0 ? 0 : Math.round((savedInputTokens / uncompressedInputTokens) * 100),
      summarizationInputTokens: params.summarizationInputTokens,
      summarizationOutputTokens: params.summarizationOutputTokens
    };
  }
}

function createSummaryId(chunk: StoredAgentMessage[]) {
  return `${chunk[0].id}:${chunk[chunk.length - 1].id}:${chunk.length}`;
}

function toAgentMessage(message: StoredAgentMessage): AgentMessage {
  return {
    role: message.role,
    content: message.content
  };
}

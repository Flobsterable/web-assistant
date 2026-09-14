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

export type ContextStrategy = 'sliding-window' | 'sticky-facts' | 'branching';

export type ConversationFacts = Record<string, string>;

export type ConversationContextReport = {
  strategy: ContextStrategy;
  keepLastMessages: number;
  fullHistoryMessages: number;
  exactHistoryMessages: number;
  fullHistoryTokens: number;
  selectedHistoryTokens: number;
  factsTokens: number;
  uncompressedInputTokens: number;
  managedInputTokens: number;
  savedInputTokens: number;
  savedInputPercent: number;
  facts: ConversationFacts;
  branch?: {
    checkpointMessageCount: number;
    branchId: string;
  };
};

export type AgentCompletionResult = {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated';
  tokenReport?: AgentTokenReport;
  contextManagement?: ConversationContextReport;
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
  loadFacts: () => Promise<ConversationFacts>;
  replaceFacts: (facts: ConversationFacts) => Promise<void>;
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
  contextStrategy?: ContextStrategy;
  keepLastMessages?: number;
  branch?: {
    checkpointMessageCount?: number;
    branchId?: string;
  };
};

type PersistedConversation = {
  version?: number;
  messages: StoredAgentMessage[];
  summaries?: ConversationSummary[];
  facts?: ConversationFacts;
};

type PreparedContext = {
  messages: AgentMessage[];
  exactMessages: StoredAgentMessage[];
  facts: ConversationFacts;
  report: ConversationContextReport;
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

function isConversationFacts(value: unknown): value is ConversationFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  return Object.values(value as Record<string, unknown>).every((fact) => typeof fact === 'string');
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
      await this.save({ ...persisted, summaries });
    });
  }

  async loadFacts() {
    return (await this.loadPersisted()).facts ?? {};
  }

  async replaceFacts(facts: ConversationFacts) {
    await this.enqueueWrite(async () => {
      const persisted = await this.loadPersisted();
      await this.save({ ...persisted, facts });
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

      await this.save({ ...persisted, messages: nextMessages });
      return nextMessages;
    });
  }

  async clear() {
    await this.enqueueWrite(async () => {
      await this.save({ messages: [], summaries: [], facts: {} });
    });
  }

  private async loadPersisted(): Promise<PersistedConversation> {
    try {
      const rawContent = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(rawContent) as Partial<PersistedConversation>;

      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isStoredAgentMessage) : [],
        summaries: Array.isArray(parsed.summaries) ? parsed.summaries.filter(isConversationSummary) : [],
        facts: isConversationFacts(parsed.facts) ? parsed.facts : {}
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { messages: [], summaries: [], facts: {} };
      }
      await this.backupUnreadableFile();
      return { messages: [], summaries: [], facts: {} };
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

  private async save(persisted: PersistedConversation) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 3, ...persisted }, null, 2)}\n`, 'utf8');
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
  private readonly contextStrategy: ContextStrategy;
  private readonly keepLastMessages: number;
  private readonly branch?: {
    checkpointMessageCount: number;
    branchId: string;
  };

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
    this.contextStrategy = options.contextStrategy ?? 'sliding-window';
    this.keepLastMessages = normalizePositiveInteger(options.keepLastMessages, 5);
    this.branch =
      options.branch?.branchId && options.branch.checkpointMessageCount !== undefined
        ? {
            branchId: options.branch.branchId,
            checkpointMessageCount: Math.max(0, Math.floor(options.branch.checkpointMessageCount))
          }
        : undefined;
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
    const facts =
      this.contextStrategy === 'sticky-facts'
        ? updateConversationFacts(await this.conversationStore.loadFacts(), normalizedRequest)
        : await this.conversationStore.loadFacts();
    const preparedContext = await this.prepareContext(fullHistory, normalizedRequest, facts);
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

    if (this.contextStrategy === 'sticky-facts') {
      await this.conversationStore.replaceFacts(facts);
    }

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
      contextManagement: preparedContext.report,
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
    const facts =
      this.contextStrategy === 'sticky-facts'
        ? updateConversationFacts(await this.conversationStore.loadFacts(), normalizedRequest)
        : await this.conversationStore.loadFacts();
    const preparedContext = await this.prepareContext(fullHistory, normalizedRequest, facts);

    return createTokenReport({
      systemPrompt: this.systemPrompt,
      selectedHistory: preparedContext.messages,
      fullHistory,
      currentRequest: normalizedRequest,
      pricing: this.tokenPricing,
      budget: this.tokenBudget
    });
  }

  private async prepareContext(
    history: StoredAgentMessage[],
    nextUserMessage: string,
    facts: ConversationFacts
  ): Promise<PreparedContext> {
    const exactMessages = this.selectMessagesForContext(history.slice(-this.keepLastMessages), nextUserMessage);
    const factMessages = this.contextStrategy === 'sticky-facts' ? createFactMessages(facts) : [];
    const contextMessages = this.trimContextMessages([...factMessages, ...exactMessages.map(toAgentMessage)], nextUserMessage);

    return {
      messages: contextMessages,
      exactMessages,
      facts,
      report: this.createContextReport({
        fullHistory: history,
        contextMessages,
        exactMessages,
        nextUserMessage,
        facts
      })
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

  private createContextReport(params: {
    fullHistory: StoredAgentMessage[];
    contextMessages: AgentMessage[];
    exactMessages: StoredAgentMessage[];
    nextUserMessage: string;
    facts: ConversationFacts;
  }): ConversationContextReport {
    const systemPromptTokens = estimateMessageTokens({ role: 'system', content: this.systemPrompt });
    const currentRequestTokens = estimateMessageTokens({ role: 'user', content: params.nextUserMessage });
    const fullHistoryTokens = estimateMessagesTokens(params.fullHistory.map(toAgentMessage));
    const selectedHistoryTokens = estimateMessagesTokens(params.contextMessages);
    const factsTokens = estimateMessagesTokens(createFactMessages(params.facts));
    const uncompressedInputTokens = systemPromptTokens + fullHistoryTokens + currentRequestTokens;
    const managedInputTokens = systemPromptTokens + selectedHistoryTokens + currentRequestTokens;
    const savedInputTokens = Math.max(0, uncompressedInputTokens - managedInputTokens);

    return {
      strategy: this.contextStrategy,
      keepLastMessages: this.keepLastMessages,
      fullHistoryMessages: params.fullHistory.length,
      exactHistoryMessages: params.exactMessages.length,
      fullHistoryTokens,
      selectedHistoryTokens,
      factsTokens,
      uncompressedInputTokens,
      managedInputTokens,
      savedInputTokens,
      savedInputPercent: uncompressedInputTokens === 0 ? 0 : Math.round((savedInputTokens / uncompressedInputTokens) * 100),
      facts: params.facts,
      branch: this.contextStrategy === 'branching' && this.branch ? this.branch : undefined
    };
  }
}

function toAgentMessage(message: StoredAgentMessage): AgentMessage {
  return {
    role: message.role,
    content: message.content
  };
}

export function createFactMessages(facts: ConversationFacts): AgentMessage[] {
  const entries = Object.entries(facts).filter(([, value]) => value.trim());
  if (entries.length === 0) return [];

  return [
    {
      role: 'system',
      content: ['Facts memory. Use these stable facts as dialogue context; do not treat them as a summary.', ...entries.map(([key, value]) => `${key}: ${value}`)].join('\n')
    }
  ];
}

export function updateConversationFacts(currentFacts: ConversationFacts, userMessage: string): ConversationFacts {
  const facts: ConversationFacts = { ...currentFacts, last_user_request: compactFact(userMessage, 220) };
  const normalized = userMessage.toLowerCase();

  if (/(цель|нужно|задача|хочу реализовать|требуется)/i.test(userMessage)) {
    facts.goal = mergeFact(facts.goal, userMessage);
  }

  if (/(огранич|нельзя|без |только|лимит|обязательно|must|should)/i.test(userMessage)) {
    facts.constraints = mergeFact(facts.constraints, userMessage);
  }

  if (/(предпоч|важно|удобн|пользователь|ui|интерфейс|стиль)/i.test(userMessage)) {
    facts.preferences = mergeFact(facts.preferences, userMessage);
  }

  if (/(решили|договор|выбираем|оставляем|будем|стратег)/i.test(userMessage)) {
    facts.decisions = mergeFact(facts.decisions, userMessage);
  }

  if (normalized.includes('сравн') || normalized.includes('качество') || normalized.includes('токен')) {
    facts.evaluation_focus = mergeFact(facts.evaluation_focus, userMessage);
  }

  return Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, compactFact(value, 520)]));
}

function mergeFact(previous: string | undefined, next: string) {
  const compactNext = compactFact(next, 220);
  if (!previous) return compactNext;
  if (previous.includes(compactNext)) return previous;
  return `${previous}; ${compactNext}`;
}

function compactFact(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1).trim()}…` : compacted;
}

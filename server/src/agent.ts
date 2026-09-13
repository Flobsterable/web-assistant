import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export type AgentCompletionResult = {
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

export type AgentRunResult = AgentCompletionResult & {
  agentName: string;
  agentProvider: string;
  modelTitle: string;
  model: string;
};

type CompletionClient = (messages: AgentMessage[], options?: { temperature?: number }) => Promise<AgentCompletionResult>;

type ConversationStore = {
  load: () => Promise<StoredAgentMessage[]>;
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
  maxContextMessages?: number;
  maxContextCharacters?: number;
};

type PersistedConversation = {
  messages: StoredAgentMessage[];
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
    try {
      const rawContent = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(rawContent) as Partial<PersistedConversation>;

      if (!Array.isArray(parsed.messages)) return [];

      return parsed.messages.filter(isStoredAgentMessage);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      await this.backupUnreadableFile();
      return [];
    }
  }

  async appendMany(messagesToAppend: Array<Omit<StoredAgentMessage, 'id' | 'createdAt'>>) {
    return this.enqueueWrite(async () => {
      const messages = await this.load();
      const createdAt = new Date().toISOString();
      const nextMessages = [
        ...messages,
        ...messagesToAppend.map((message) => ({
          ...message,
          id: createMessageId(),
          createdAt
        }))
      ].slice(-this.maxStoredMessages);

      await this.save(nextMessages);
      return nextMessages;
    });
  }

  async clear() {
    await this.enqueueWrite(async () => {
      await this.save([]);
    });
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

  private async save(messages: StoredAgentMessage[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, messages }, null, 2)}\n`, 'utf8');
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
  private readonly maxContextMessages: number;
  private readonly maxContextCharacters: number;

  constructor(options: SimpleAgentOptions) {
    this.name = options.name;
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt;
    this.temperature = options.temperature;
    this.modelTitle = options.modelTitle;
    this.model = options.model;
    this.complete = options.complete;
    this.conversationStore = options.conversationStore;
    this.maxContextMessages = normalizePositiveInteger(options.maxContextMessages, 40);
    this.maxContextCharacters = normalizePositiveInteger(options.maxContextCharacters, 24_000);
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

    const contextMessages = this.selectMessagesForContext(await this.conversationStore.load(), normalizedRequest);

    const completion = await this.complete(
      [
        {
          role: 'system',
          content: this.systemPrompt
        },
        ...contextMessages.map((message) => ({
          role: message.role,
          content: message.content
        })),
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
      agentName: this.name,
      agentProvider: this.provider,
      modelTitle: this.modelTitle,
      model: this.model
    };
  }

  private selectMessagesForContext(history: StoredAgentMessage[], nextUserMessage: string) {
    const recentMessages = history.slice(-this.maxContextMessages);
    const selectedMessages: StoredAgentMessage[] = [];
    let characterCount = nextUserMessage.length;

    for (const message of [...recentMessages].reverse()) {
      const nextCharacterCount = characterCount + message.content.length;

      if (selectedMessages.length > 0 && nextCharacterCount > this.maxContextCharacters) break;

      selectedMessages.unshift(message);
      characterCount = nextCharacterCount;
    }

    return selectedMessages;
  }
}

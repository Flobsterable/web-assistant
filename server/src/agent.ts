export type AgentMessage = {
  role: 'system' | 'user';
  content: string;
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

type SimpleAgentOptions = {
  name: string;
  provider: string;
  systemPrompt: string;
  temperature: number;
  modelTitle: string;
  model: string;
  complete: CompletionClient;
};

export class SimpleAgent {
  private readonly name: string;
  private readonly provider: string;
  private readonly systemPrompt: string;
  private readonly temperature: number;
  private readonly modelTitle: string;
  private readonly model: string;
  private readonly complete: CompletionClient;

  constructor(options: SimpleAgentOptions) {
    this.name = options.name;
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt;
    this.temperature = options.temperature;
    this.modelTitle = options.modelTitle;
    this.model = options.model;
    this.complete = options.complete;
  }

  async run(userRequest: string): Promise<AgentRunResult> {
    const normalizedRequest = userRequest.trim();

    if (!normalizedRequest) {
      throw new Error('User request is required.');
    }

    const completion = await this.complete(
      [
        {
          role: 'system',
          content: this.systemPrompt
        },
        {
          role: 'user',
          content: normalizedRequest
        }
      ],
      { temperature: this.temperature }
    );

    return {
      ...completion,
      agentName: this.name,
      agentProvider: this.provider,
      modelTitle: this.modelTitle,
      model: this.model
    };
  }
}

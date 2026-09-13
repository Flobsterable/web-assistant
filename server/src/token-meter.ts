import type { AgentMessage, StoredAgentMessage } from './agent.js';

export type TokenPricing = {
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  priceCurrency: string;
};

export type TokenBudget = {
  maxContextTokens: number;
  reservedOutputTokens: number;
};

export type AgentTokenReport = {
  source: 'api' | 'estimated';
  currentRequestTokens: number;
  selectedHistoryTokens: number;
  fullHistoryTokens: number;
  systemPromptTokens: number;
  inputTokens: number;
  outputTokens: number | null;
  totalTokens: number | null;
  maxContextTokens: number;
  reservedOutputTokens: number;
  availableInputTokens: number;
  overflowTokens: number;
  willOverflow: boolean;
  estimatedInputCost: number | null;
  estimatedOutputCost: number | null;
  estimatedTotalCost: number | null;
  priceCurrency: string;
};

export type TokenGrowthPoint = {
  turn: number;
  scenario: string;
  currentRequestTokens: number;
  fullHistoryTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  overflowTokens: number;
  willOverflow: boolean;
  estimatedTotalCost: number | null;
};

export type TokenScenarioReport = {
  id: string;
  title: string;
  description: string;
  failureMode: string | null;
  points: TokenGrowthPoint[];
};

export type HistoryTokenStats = {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  fullHistoryTokens: number;
  maxContextTokens: number;
  reservedOutputTokens: number;
  availableInputTokens: number;
  usedInputTokens: number;
  remainingInputTokens: number;
  usedContextTokens: number;
  remainingContextTokens: number;
  contextUsedPercent: number;
  overflowTokens: number;
  willOverflowOnNextSmallRequest: boolean;
  estimatedReplayCost: number | null;
  priceCurrency: string;
};

const MESSAGE_OVERHEAD_TOKENS = 4;
const fallbackTokenBudget: TokenBudget = {
  maxContextTokens: 8_192,
  reservedOutputTokens: 1_024
};

export function normalizeTokenBudget(value?: Partial<TokenBudget>, fallback: TokenBudget = fallbackTokenBudget): TokenBudget {
  return {
    maxContextTokens: normalizePositiveInteger(value?.maxContextTokens, fallback.maxContextTokens),
    reservedOutputTokens: normalizePositiveInteger(value?.reservedOutputTokens, fallback.reservedOutputTokens)
  };
}

export function estimateTokens(text: string) {
  if (!text.trim()) return 0;

  const cyrillicWeight = /[а-яё]/i.test(text) ? 3.2 : 4;
  return Math.max(1, Math.ceil(text.length / cyrillicWeight));
}

export function estimateMessageTokens(message: Pick<AgentMessage, 'role' | 'content'>) {
  return MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.role) + estimateTokens(message.content);
}

export function estimateMessagesTokens(messages: Array<Pick<AgentMessage, 'role' | 'content'>>) {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function calculateCost(
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: Pick<TokenPricing, 'inputPricePerMillion' | 'outputPricePerMillion'>
) {
  if (
    inputTokens === null ||
    outputTokens === null ||
    pricing.inputPricePerMillion === null ||
    pricing.outputPricePerMillion === null
  ) {
    return null;
  }

  return (inputTokens / 1_000_000) * pricing.inputPricePerMillion + (outputTokens / 1_000_000) * pricing.outputPricePerMillion;
}

export function createTokenReport(params: {
  systemPrompt: string;
  selectedHistory: StoredAgentMessage[];
  fullHistory: StoredAgentMessage[];
  currentRequest: string;
  outputText?: string;
  apiInputTokens?: number | null;
  apiOutputTokens?: number | null;
  apiTotalTokens?: number | null;
  tokenSource?: 'api' | 'estimated';
  budget?: Partial<TokenBudget>;
  pricing: TokenPricing;
}): AgentTokenReport {
  const budget = normalizeTokenBudget(params.budget);
  const currentRequestMessage = { role: 'user' as const, content: params.currentRequest };
  const selectedHistoryMessages = params.selectedHistory.map(toAgentMessage);
  const fullHistoryMessages = params.fullHistory.map(toAgentMessage);
  const systemPromptTokens = estimateMessageTokens({ role: 'system', content: params.systemPrompt });
  const currentRequestTokens = estimateMessageTokens(currentRequestMessage);
  const selectedHistoryTokens = estimateMessagesTokens(selectedHistoryMessages);
  const fullHistoryTokens = estimateMessagesTokens(fullHistoryMessages);
  const estimatedInputTokens = systemPromptTokens + selectedHistoryTokens + currentRequestTokens;
  const estimatedOutputTokens = params.outputText === undefined ? null : estimateTokens(params.outputText);
  const inputTokens = params.apiInputTokens ?? estimatedInputTokens;
  const outputTokens = params.apiOutputTokens ?? estimatedOutputTokens;
  const totalTokens = params.apiTotalTokens ?? (outputTokens === null ? null : inputTokens + outputTokens);
  const availableInputTokens = Math.max(0, budget.maxContextTokens - budget.reservedOutputTokens);
  const overflowTokens = Math.max(0, estimatedInputTokens - availableInputTokens);
  const estimatedInputCost =
    params.pricing.inputPricePerMillion === null ? null : (inputTokens / 1_000_000) * params.pricing.inputPricePerMillion;
  const estimatedOutputCost =
    outputTokens === null || params.pricing.outputPricePerMillion === null
      ? null
      : (outputTokens / 1_000_000) * params.pricing.outputPricePerMillion;

  return {
    source: params.tokenSource ?? (params.apiTotalTokens ? 'api' : 'estimated'),
    currentRequestTokens,
    selectedHistoryTokens,
    fullHistoryTokens,
    systemPromptTokens,
    inputTokens,
    outputTokens,
    totalTokens,
    maxContextTokens: budget.maxContextTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    availableInputTokens,
    overflowTokens,
    willOverflow: overflowTokens > 0,
    estimatedInputCost,
    estimatedOutputCost,
    estimatedTotalCost:
      estimatedInputCost === null || estimatedOutputCost === null ? null : estimatedInputCost + estimatedOutputCost,
    priceCurrency: params.pricing.priceCurrency
  };
}

export function createHistoryTokenStats(params: {
  history: StoredAgentMessage[];
  budget?: Partial<TokenBudget>;
  pricing: TokenPricing;
}): HistoryTokenStats {
  const budget = normalizeTokenBudget(params.budget);
  const fullHistoryTokens = estimateMessagesTokens(params.history.map(toAgentMessage));
  const availableInputTokens = Math.max(0, budget.maxContextTokens - budget.reservedOutputTokens);
  const usedInputTokens = Math.min(fullHistoryTokens, availableInputTokens);
  const remainingInputTokens = Math.max(0, availableInputTokens - fullHistoryTokens);
  const usedContextTokens = Math.min(fullHistoryTokens + budget.reservedOutputTokens, budget.maxContextTokens);
  const remainingContextTokens = Math.max(0, budget.maxContextTokens - fullHistoryTokens - budget.reservedOutputTokens);
  const contextUsedPercent = budget.maxContextTokens === 0 ? 0 : Math.min(100, Math.round((usedContextTokens / budget.maxContextTokens) * 100));
  const smallNextRequestTokens = estimateMessageTokens({ role: 'user', content: 'Следующий короткий запрос.' });
  const overflowTokens = Math.max(0, fullHistoryTokens + smallNextRequestTokens - availableInputTokens);
  const estimatedReplayCost =
    params.pricing.inputPricePerMillion === null
      ? null
      : (fullHistoryTokens / 1_000_000) * params.pricing.inputPricePerMillion;

  return {
    messageCount: params.history.length,
    userMessageCount: params.history.filter((message) => message.role === 'user').length,
    assistantMessageCount: params.history.filter((message) => message.role === 'assistant').length,
    fullHistoryTokens,
    maxContextTokens: budget.maxContextTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    availableInputTokens,
    usedInputTokens,
    remainingInputTokens,
    usedContextTokens,
    remainingContextTokens,
    contextUsedPercent,
    overflowTokens,
    willOverflowOnNextSmallRequest: overflowTokens > 0,
    estimatedReplayCost,
    priceCurrency: params.pricing.priceCurrency
  };
}

export function buildTokenDemo(pricing: TokenPricing, budget?: Partial<TokenBudget>): TokenScenarioReport[] {
  const normalizedBudget = normalizeTokenBudget(budget);
  const systemPrompt = 'Ты агент поддержки. Учитывай всю историю диалога и отвечай по делу.';

  return [
    createScenario({
      id: 'short',
      title: 'Короткий диалог',
      description: 'История маленькая: почти весь бюджет уходит на текущий запрос и ответ.',
      turns: 3,
      userWords: 18,
      assistantWords: 34,
      systemPrompt,
      pricing,
      budget: normalizedBudget
    }),
    createScenario({
      id: 'long',
      title: 'Длинный диалог',
      description: 'История растёт, каждый следующий вызов повторно оплачивает больше прошлых сообщений.',
      turns: 14,
      userWords: 130,
      assistantWords: 220,
      systemPrompt,
      pricing,
      budget: normalizedBudget
    }),
    createScenario({
      id: 'overflow',
      title: 'Диалог выше лимита модели',
      description: 'История становится больше доступного окна контекста.',
      turns: 22,
      userWords: 560,
      assistantWords: 760,
      systemPrompt,
      pricing,
      budget: normalizedBudget
    })
  ];
}

function createScenario(params: {
  id: string;
  title: string;
  description: string;
  turns: number;
  userWords: number;
  assistantWords: number;
  systemPrompt: string;
  pricing: TokenPricing;
  budget: TokenBudget;
}): TokenScenarioReport {
  const history: StoredAgentMessage[] = [];
  const points: TokenGrowthPoint[] = [];

  for (let turn = 1; turn <= params.turns; turn += 1) {
    const currentRequest = createRepeatedText(`Запрос ${turn}: уточни план реализации и риски`, params.userWords);
    const assistantAnswer = createRepeatedText(`Ответ ${turn}: анализирую контекст, решение, ограничения и следующий шаг`, params.assistantWords);
    const report = createTokenReport({
      systemPrompt: params.systemPrompt,
      selectedHistory: history,
      fullHistory: history,
      currentRequest,
      outputText: assistantAnswer,
      pricing: params.pricing,
      budget: params.budget
    });

    points.push({
      turn,
      scenario: params.id,
      currentRequestTokens: report.currentRequestTokens,
      fullHistoryTokens: report.fullHistoryTokens,
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens ?? 0,
      totalTokens: report.totalTokens ?? report.inputTokens,
      overflowTokens: report.overflowTokens,
      willOverflow: report.willOverflow,
      estimatedTotalCost: report.estimatedTotalCost
    });

    history.push(createStoredMessage('user', currentRequest, turn), createStoredMessage('assistant', assistantAnswer, turn));
  }

  return {
    id: params.id,
    title: params.title,
    description: params.description,
    failureMode: points.some((point) => point.willOverflow)
      ? 'Без обрезки или сжатия истории модель вернет ошибку контекстного окна; если обрезать резко, агент потеряет ранние факты.'
      : null,
    points
  };
}

function toAgentMessage(message: StoredAgentMessage): AgentMessage {
  return {
    role: message.role,
    content: message.content
  };
}

function createStoredMessage(role: StoredAgentMessage['role'], content: string, turn: number): StoredAgentMessage {
  return {
    id: `${role}-${turn}`,
    role,
    content,
    createdAt: new Date(0).toISOString()
  };
}

function createRepeatedText(seed: string, approximateWords: number) {
  const words = seed.split(/\s+/);
  const result: string[] = [];

  while (result.length < approximateWords) {
    result.push(...words);
  }

  return result.slice(0, approximateWords).join(' ');
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

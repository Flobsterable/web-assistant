import { FormEvent, useEffect, useMemo, useState } from 'react';

type AgentResponse = {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated';
  tokenReport?: AgentTokenReport;
  contextManagement?: ContextManagementReport;
  cost: number | null;
  priceCurrency: string;
  elapsedMs: number;
  finishReason: string | null;
  agentName: string;
  modelTitle: string;
  model: string;
  session?: AgentSession;
  stats?: HistoryTokenStats;
  turnId?: string;
  memoryEvents?: MemoryEvent[];
};

type AgentErrorResponse = {
  error?: string;
  tokenReport?: AgentTokenReport;
};

type PublicModelConfig = {
  id: string;
  provider: 'openai-compatible' | 'gemini';
  title: string;
  baseUrl: string;
  model: string;
  sourceUrl: string | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  priceCurrency: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
};

type AppConfig = {
  models: PublicModelConfig[];
  hasApiKey: boolean;
  error?: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'agent';
  content: string;
  createdAt?: string;
  meta?: AgentResponse;
  tokenMeta?: RequestTokenMeta;
  responseMeta?: ResponseTokenMeta;
};

type AgentSession = {
  sessionId: string;
  title: string;
};

type AgentHistoryResponse = {
  session: AgentSession;
  messages: ChatMessage[];
  stats: HistoryTokenStats;
};

type AgentChatSummary = AgentSession & {
  messageCount: number;
  fullHistoryTokens: number;
  updatedAt: string | null;
  lastMessagePreview: string | null;
};

type AgentChatsResponse = {
  chats: AgentChatSummary[];
};

type RequestTokenMeta = {
  currentRequestTokens: number;
  fullHistoryTokens: number;
  selectedHistoryTokens: number;
  inputTokens: number;
  maxContextTokens: number;
  remainingInputTokens: number;
  priceCurrency: string;
  estimatedInputCost: number | null;
};

type ResponseTokenMeta = {
  outputTokens: number;
  totalTokens: number | null;
  priceCurrency: string;
  estimatedOutputCost: number | null;
  estimatedTotalCost: number | null;
};

type AgentTokenReport = {
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

type ContextManagementReport = {
  keepLastMessages: number;
  fullHistoryMessages: number;
  exactHistoryMessages: number;
  fullHistoryTokens: number;
  selectedHistoryTokens: number;
  uncompressedInputTokens: number;
  managedInputTokens: number;
  savedInputTokens: number;
  savedInputPercent: number;
  memory: {
    workingEnabled: boolean;
    longTermEnabled: boolean;
    shortTermMessages: number;
    workingItems: number;
    longTermItems: number;
    workingTokens: number;
    longTermTokens: number;
    appliedWorkingIds: string[];
    appliedLongTermIds: string[];
  };
};

type HistoryTokenStats = {
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

type MemoryLayer = 'working' | 'long-term';
type MemoryCategory = 'goal' | 'constraint' | 'artifact' | 'note' | 'profile' | 'decision' | 'knowledge';

type MemoryEntry = {
  id: string;
  layer: MemoryLayer;
  category: MemoryCategory;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
};

type MemoryResponse = {
  sessionId: string;
  layers: {
    shortTerm: { scope: string; storage: string; messages: ChatMessage[] };
    working: { scope: string; storage: string; entries: MemoryEntry[] };
    longTerm: { scope: string; storage: string; entries: MemoryEntry[] };
  };
};

type MemoryCandidate = {
  scope: 'none' | MemoryLayer;
  operation: 'create' | 'update' | 'delete' | 'skip';
  category?: MemoryCategory;
  key: string;
  value?: string;
  targetId?: string;
  confidence: number;
  importance?: number;
  reason: string;
};

type MemoryEvent = {
  type: string;
  scope: 'none' | MemoryLayer;
  candidate?: MemoryCandidate;
  reason: string;
};

type PendingMemorySuggestion = {
  id: string;
  candidate: MemoryCandidate & { scope: 'long-term' };
  createdAt: string;
};

type PendingMemoryResponse = { sessionId: string; suggestions: PendingMemorySuggestion[] };

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(2)} с`;
}

function formatCost(cost: number | null, currency: string) {
  if (cost === null) return 'не указана';
  if (cost === 0) return `0 ${currency}`;
  return `${cost.toFixed(6)} ${currency}`;
}

function formatTokens(value: number | null | undefined) {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('ru-RU').format(value);
}

function memoryCategoryTitle(category: MemoryCategory | undefined) {
  const titles: Record<MemoryCategory, string> = {
    goal: 'Цель', constraint: 'Ограничение', artifact: 'Материал', note: 'Заметка',
    profile: 'О пользователе', decision: 'Решение', knowledge: 'Знание'
  };
  return category ? titles[category] : 'Память';
}

function memoryKeyTitle(key: string) {
  const titles: Record<string, string> = {
    'task.goal': 'Цель задачи',
    'task.state': 'Текущее состояние',
    'task.constraints': 'Ограничения',
    'task.decisions': 'Принятые решения',
    'task.artifacts': 'Материалы и файлы',
    'task.next_steps': 'Следующие шаги',
    'profile.language': 'Язык общения',
    'profile.communication_style': 'Стиль общения',
    'profile.role': 'Роль и сфера деятельности',
    'profile.preferences': 'Предпочтения',
    'profile.constraints': 'Постоянные ограничения',
    'profile.summary': 'Краткий профиль'
  };
  return titles[key] ?? key;
}

function memoryEventTitle(type: string, scope: MemoryEvent['scope']) {
  if (type === 'created') return scope === 'long-term' ? 'Запомнил о вас' : 'Запомнил для этой задачи';
  if (type === 'updated') return scope === 'long-term' ? 'Обновил сведения о вас' : 'Обновил память задачи';
  if (type === 'deleted') return 'Удалил из памяти задачи';
  if (type === 'suggestion_created') return 'Предложил сохранить надолго';
  if (type === 'clarification_required') return 'Нужно уточнить перед сохранением';
  return 'Память не изменена';
}

function toRequestTokenMeta(tokenReport: AgentTokenReport): RequestTokenMeta {
  return {
    currentRequestTokens: tokenReport.currentRequestTokens,
    fullHistoryTokens: tokenReport.fullHistoryTokens,
    selectedHistoryTokens: tokenReport.selectedHistoryTokens,
    inputTokens: tokenReport.inputTokens,
    maxContextTokens: tokenReport.maxContextTokens,
    remainingInputTokens: Math.max(0, tokenReport.availableInputTokens - tokenReport.inputTokens),
    priceCurrency: tokenReport.priceCurrency,
    estimatedInputCost: tokenReport.estimatedInputCost
  };
}

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSessionId() {
  return `win-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function readInitialSessionId() {
  const urlSessionId = new URLSearchParams(window.location.search).get('sessionId');
  if (urlSessionId) return urlSessionId;

  return window.localStorage.getItem('agent-session-id') ?? createSessionId();
}

function readMemoryToggle(key: string) {
  return window.localStorage.getItem(key) !== 'false';
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isAgent = message.role === 'agent';
  const visibleMemoryEvents = message.meta?.memoryEvents?.filter((event) => event.type !== 'skipped' && event.type !== 'invalid_candidate') ?? [];

  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">{isAgent ? 'Агент' : 'Вы'}</div>
      <div className="message-body">{message.content}</div>
      {message.meta && (
        <footer className="message-meta">
          <span>{message.meta.modelTitle}</span>
          <span>{formatDuration(message.meta.elapsedMs)}</span>
        </footer>
      )}
      {visibleMemoryEvents.length > 0 ? (
        <footer className="message-meta memory-decisions">
          {visibleMemoryEvents.map((event, index) => (
            <span key={`${event.type}-${index}`} title={event.reason}>
              {memoryEventTitle(event.type, event.scope)}{event.candidate?.key ? `: ${event.candidate.key}` : ''}
            </span>
          ))}
        </footer>
      ) : null}
      {message.meta?.contextManagement && (
        <details className="message-details">
          <summary>Технические детали</summary>
          <div className="message-details-grid">
            <span>Модель: {message.meta.model}</span>
            <span>Запрос: {formatTokens(message.meta.tokenReport?.currentRequestTokens)} токенов</span>
            <span>История: {formatTokens(message.meta.tokenReport?.fullHistoryTokens)} токенов</span>
            <span>Ответ: {formatTokens(message.meta.tokenReport?.outputTokens ?? message.meta.outputTokens)} токенов</span>
            <span>Контекст: {formatTokens(message.meta.contextManagement.managedInputTokens)} токенов</span>
            <span>Экономия: {message.meta.contextManagement.savedInputPercent}%</span>
            <span>Память задачи: {message.meta.contextManagement.memory.appliedWorkingIds.length}</span>
            <span>Долгая память: {message.meta.contextManagement.memory.appliedLongTermIds.length}</span>
            <span>Рабочая: {message.meta.contextManagement.memory.workingEnabled ? 'включена' : 'выключена'}</span>
            <span>Долговременная: {message.meta.contextManagement.memory.longTermEnabled ? 'включена' : 'выключена'}</span>
            <span>Стоимость: {formatCost(message.meta.cost, message.meta.priceCurrency)}</span>
          </div>
        </details>
      )}
      {message.responseMeta && !message.meta && (
        <footer className="message-meta">
          <span>ответ: {formatTokens(message.responseMeta.outputTokens)}</span>
          <span>total: {formatTokens(message.responseMeta.totalTokens)}</span>
          <span>стоимость ответа: {formatCost(message.responseMeta.estimatedOutputCost, message.responseMeta.priceCurrency)}</span>
          <span>стоимость total: {formatCost(message.responseMeta.estimatedTotalCost, message.responseMeta.priceCurrency)}</span>
        </footer>
      )}
      {message.tokenMeta && (
        <details className="message-details">
          <summary>Детали запроса</summary>
          <div className="message-details-grid">
            <span>Запрос: {formatTokens(message.tokenMeta.currentRequestTokens)}</span>
            <span>История: {formatTokens(message.tokenMeta.fullHistoryTokens)}</span>
            <span>В контексте: {formatTokens(message.tokenMeta.selectedHistoryTokens)}</span>
            <span>Осталось: {formatTokens(message.tokenMeta.remainingInputTokens)}</span>
          </div>
        </details>
      )}
    </article>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [configError, setConfigError] = useState('');
  const [sessionId, setSessionId] = useState(() => readInitialSessionId());
  const [session, setSession] = useState<AgentSession>();
  const [chats, setChats] = useState<AgentChatSummary[]>([]);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyStats, setHistoryStats] = useState<HistoryTokenStats>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [memory, setMemory] = useState<MemoryResponse>();
  const [pendingMemory, setPendingMemory] = useState<PendingMemorySuggestion[]>([]);
  const [memoryLayer, setMemoryLayer] = useState<MemoryLayer>('working');
  const [memoryCategory, setMemoryCategory] = useState<MemoryCategory>('goal');
  const [memoryKey, setMemoryKey] = useState('');
  const [memoryValue, setMemoryValue] = useState('');
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);
  const [useWorkingMemory, setUseWorkingMemory] = useState(() => readMemoryToggle('use-working-memory'));
  const [useLongTermMemory, setUseLongTermMemory] = useState(() => readMemoryToggle('use-long-term-memory'));
  const [selectedModelId, setSelectedModelId] = useState(() => window.localStorage.getItem('agent-model-id') ?? 'flash');

  const selectedModel = useMemo(
    () => config?.models.find((model) => model.id === selectedModelId) ?? config?.models[0],
    [config, selectedModelId]
  );

  useEffect(() => {
    const controller = new AbortController();

    async function loadInitialData() {
      try {
        const sessionQuery = new URLSearchParams({ sessionId }).toString();
        const [configResponse, chatsResponse, historyResponse, memoryResponse, pendingResponse] = await Promise.all([
          fetch('/api/config', { signal: controller.signal }),
          fetch('/api/agent/chats', { signal: controller.signal }),
          fetch(`/api/agent/history?${sessionQuery}`, { signal: controller.signal }),
          fetch(`/api/agent/memory?${sessionQuery}`, { signal: controller.signal }),
          fetch(`/api/agent/memory/pending?${sessionQuery}`, { signal: controller.signal })
        ]);
        const data = (await configResponse.json()) as AppConfig;

        if (!configResponse.ok) {
          throw new Error('Не удалось загрузить конфигурацию.');
        }

        setConfig(data);
        const savedModelId = window.localStorage.getItem('agent-model-id');
        const nextModel = data.models.find((model) => model.id === savedModelId)
          ?? data.models.find((model) => model.id === 'flash')
          ?? data.models[0];
        if (nextModel) {
          setSelectedModelId(nextModel.id);
          window.localStorage.setItem('agent-model-id', nextModel.id);
        }

        if (chatsResponse.ok) {
          const chatsData = (await chatsResponse.json()) as AgentChatsResponse;
          setChats(chatsData.chats);

          const hasUrlSession = Boolean(new URLSearchParams(window.location.search).get('sessionId'));
          const hasCurrentChat = chatsData.chats.some((chat) => chat.sessionId === sessionId);
          const shouldOpenExistingChat = !hasUrlSession && !hasCurrentChat && chatsData.chats.length > 0;

          if (shouldOpenExistingChat) {
            openChat(chatsData.chats[0].sessionId, { replace: true });
            return;
          }
        }

        if (data.error) {
          setConfigError(`Заполните .env: ${data.error}`);
        } else if (historyResponse.ok) {
          const history = (await historyResponse.json()) as AgentHistoryResponse;
          setSession(history.session);
          setMessages(history.messages);
          setHistoryStats(history.stats);
        }

        if (memoryResponse.ok) {
          setMemory((await memoryResponse.json()) as MemoryResponse);
        }
        if (pendingResponse.ok) {
          setPendingMemory(((await pendingResponse.json()) as PendingMemoryResponse).suggestions);
        }

      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return;
        setConfigError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить конфигурацию.');
      }
    }

    void loadInitialData();
    return () => controller.abort();
  }, [sessionId]);

  function openChat(nextSessionId: string, options?: { replace?: boolean }) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('sessionId', nextSessionId);
    if (options?.replace) {
      window.history.replaceState(null, '', nextUrl);
    } else {
      window.history.pushState(null, '', nextUrl);
    }
    window.localStorage.setItem('agent-session-id', nextSessionId);
    setSessionId(nextSessionId);
    setSession(undefined);
    setMessages([]);
    setHistoryStats(undefined);
    setMemory(undefined);
    setPendingMemory([]);
    setError('');
  }

  function handleNewChat() {
    openChat(createSessionId());
  }

  async function handleDeleteChat(chatSessionId: string) {
    setError('');

    try {
      const response = await fetch(`/api/agent/chats/${encodeURIComponent(chatSessionId)}`, { method: 'DELETE' });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? 'Не удалось удалить чат.');
      }

      const nextChats = chats.filter((chat) => chat.sessionId !== chatSessionId);
      setChats(nextChats);

      if (chatSessionId === sessionId) {
        const nextSessionId = nextChats[0]?.sessionId ?? createSessionId();
        openChat(nextSessionId, { replace: true });
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить чат.');
    }
  }

  async function handleReset() {
    setMessage('');
    setMessages([]);
    setHistoryStats(undefined);
    setError('');

    try {
      const sessionQuery = new URLSearchParams({ sessionId }).toString();
      const response = await fetch(`/api/agent/history?${sessionQuery}`, { method: 'DELETE' });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? 'Не удалось очистить историю агента.');
      }

      void refreshChats();
      void refreshMemory();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось очистить историю агента.');
    }
  }

  function handleMemoryLayerChange(layer: MemoryLayer) {
    setMemoryLayer(layer);
    setMemoryCategory(layer === 'working' ? 'goal' : 'profile');
  }

  async function refreshMemory() {
    const query = new URLSearchParams({ sessionId }).toString();
    const [response, pendingResponse] = await Promise.all([
      fetch(`/api/agent/memory?${query}`),
      fetch(`/api/agent/memory/pending?${query}`)
    ]);
    if (!response.ok || !pendingResponse.ok) throw new Error('Не удалось загрузить память.');
    setMemory((await response.json()) as MemoryResponse);
    setPendingMemory(((await pendingResponse.json()) as PendingMemoryResponse).suggestions);
  }

  async function handlePendingMemory(id: string, action: 'approve' | 'reject') {
    setError('');
    try {
      const response = await fetch(`/api/agent/memory/pending/${encodeURIComponent(id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId })
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Не удалось обработать предложение памяти.');
      await refreshMemory();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось обработать предложение памяти.');
    }
  }

  async function handleSaveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setIsSavingMemory(true);

    try {
      const response = await fetch('/api/agent/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          layer: memoryLayer,
          category: memoryCategory,
          key: memoryKey,
          value: memoryValue
        })
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Не удалось сохранить память.');
      setMemoryKey('');
      setMemoryValue('');
      await refreshMemory();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить память.');
    } finally {
      setIsSavingMemory(false);
    }
  }

  async function handleDeleteMemory(layer: MemoryLayer, id: string) {
    setError('');
    const query = new URLSearchParams({ sessionId }).toString();
    try {
      const response = await fetch(`/api/agent/memory/${layer}/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Не удалось удалить запись памяти.');
      await refreshMemory();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить запись памяти.');
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      setError('Введите запрос.');
      return;
    }

    setIsLoading(true);
    setError('');
    setMessage('');

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: 'user',
      content: trimmedMessage
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: trimmedMessage,
          sessionId,
          modelId: selectedModel?.id,
          useWorkingMemory,
          useLongTermMemory
        })
      });

      const data = (await response.json()) as AgentResponse | AgentErrorResponse;

      if (!response.ok) {
        if ('tokenReport' in data && data.tokenReport) {
          setMessages((currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === userMessage.id
                ? {
                    ...currentMessage,
                    tokenMeta: toRequestTokenMeta(data.tokenReport as AgentTokenReport)
                  }
                : currentMessage
            )
          );
        }
        throw new Error('error' in data && data.error ? data.error : 'Не удалось получить ответ агента.');
      }

      const agentResponse = data as AgentResponse;
      if (agentResponse.session) setSession(agentResponse.session);
      if (agentResponse.stats) setHistoryStats(agentResponse.stats);
      void refreshChats();
      void refreshMemory();
      setMessages((currentMessages) => [
        ...currentMessages.map((currentMessage) =>
          currentMessage.id === userMessage.id && agentResponse.tokenReport
            ? {
                ...currentMessage,
                tokenMeta: toRequestTokenMeta(agentResponse.tokenReport)
              }
            : currentMessage
        ),
        {
          id: createMessageId(),
          role: 'agent',
          content: agentResponse.answer,
          meta: agentResponse
        }
      ]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Произошла ошибка.');
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshChats() {
    try {
      const response = await fetch('/api/agent/chats');
      if (!response.ok) return;
      const data = (await response.json()) as AgentChatsResponse;
      setChats(data.chats);
    } catch {
      // Chat list is supporting UI; message delivery should stay independent.
    }
  }

  return (
    <main className="page-shell">
      <div className="app-layout">
        <aside className="chat-sidebar" aria-label="Чаты агента">
          <div className="sidebar-header">
            <div>
              <span>История</span>
              <strong>Чаты агента</strong>
            </div>
            <button type="button" onClick={handleNewChat}>
              Новый чат
            </button>
          </div>

          <div className="chat-list">
            {chats.length === 0 ? (
              <p className="chat-list-empty">Сохранённых чатов пока нет.</p>
            ) : (
              chats.map((chat) => (
                <div className={`chat-list-item ${chat.sessionId === sessionId ? 'active' : ''}`} key={chat.sessionId}>
                  <button className="chat-open-button" type="button" onClick={() => openChat(chat.sessionId)}>
                    <span>{chat.title}</span>
                    {chat.lastMessagePreview && <small>{chat.lastMessagePreview}</small>}
                  </button>
                  <button className="chat-delete-button" type="button" onClick={() => void handleDeleteChat(chat.sessionId)} aria-label={`Удалить чат ${chat.title}`}>
                    Удалить
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        <div className="app-frame">
          <header className="chat-header">
            <div className="chat-heading">
              <strong>{session?.title ?? 'Новый чат'}</strong>
              <code>{sessionId}</code>
            </div>
            <div className="chat-header-actions">
              <span className={`api-status ${selectedModel ? 'ready' : 'pending'}`}>
                <span className="status-dot" /> {selectedModel ? selectedModel.model : 'Подключение'}
              </span>
              <button type="button" onClick={handleNewChat}>
                Новый чат
              </button>
            </div>
          </header>

          {(selectedModel || historyStats) && (
            <section className={`compact-metrics ${historyStats?.willOverflowOnNextSmallRequest ? 'overflow' : ''}`} aria-label="Лимиты и статистика">
              {selectedModel && (
                <>
                  <span>Провайдер: <strong>{selectedModel.provider}</strong></span>
                  <span>Контекст: <strong>{formatTokens(selectedModel.maxContextTokens)}</strong></span>
                </>
              )}
              {historyStats && (
                <>
                  <span>История: <strong>{formatTokens(historyStats.fullHistoryTokens)}</strong></span>
                  <span>Input: <strong>{formatTokens(historyStats.availableInputTokens)}</strong></span>
                  <span>Осталось: <strong>{formatTokens(historyStats.remainingInputTokens)}</strong></span>
                  <span>Резерв ответа: <strong>{formatTokens(historyStats.reservedOutputTokens)}</strong></span>
                  <span>Использовано: <strong>{historyStats.contextUsedPercent}%</strong></span>
                  <span className="metric-risk">Риск: <strong>{historyStats.willOverflowOnNextSmallRequest ? `+${formatTokens(historyStats.overflowTokens)}` : 'нет'}</strong></span>
                </>
              )}
              {historyStats && (
                <span className="compact-meter" aria-hidden="true">
                  <span style={{ width: `${historyStats.contextUsedPercent}%` }} />
                </span>
              )}
            </section>
          )}

          <section className="memory-panel" aria-label="Память агента">
            <div className="memory-heading">
              <div>
                <span>Память агента</span>
                <strong>Агент помнит важное</strong>
                <p>Свежие сообщения остаются в окне, задача сжимается в рабочий контекст, а важные сведения профиля агент запоминает автоматически.</p>
              </div>
              <button
                className="memory-toggle"
                type="button"
                aria-expanded={isMemoryOpen}
                onClick={() => setIsMemoryOpen((isOpen) => !isOpen)}
              >
                {isMemoryOpen ? 'Скрыть настройки' : 'Управление памятью'}
                <span aria-hidden="true">{isMemoryOpen ? '↑' : '↓'}</span>
              </button>
            </div>

            <div className="memory-summary" aria-label="Состояние памяти">
              <div><strong>{memory?.layers.shortTerm.messages.length ?? messages.length}</strong><span>сообщений в чате</span></div>
              <div><strong>{memory?.layers.working.entries.length ? 'Готов' : '—'}</strong><span>контекст задачи</span></div>
              <div><strong>{memory?.layers.longTerm.entries.length ?? 0}</strong><span>сохранено надолго</span></div>
              {pendingMemory.length > 0 && <div className="attention"><strong>{pendingMemory.length}</strong><span>ждёт решения</span></div>}
            </div>

            <div className="memory-switches" aria-label="Использование памяти в ответах">
              <label>
                <span className="memory-switch-copy">
                  <strong>Рабочая память</strong>
                  <small>Сжатый контекст текущей задачи</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={useWorkingMemory}
                  onChange={(event) => {
                    setUseWorkingMemory(event.target.checked);
                    window.localStorage.setItem('use-working-memory', String(event.target.checked));
                  }}
                />
                <span className="memory-switch-control" aria-hidden="true" />
              </label>
              <label>
                <span className="memory-switch-copy">
                  <strong>Долговременная память</strong>
                  <small>Персональные сведения из всех чатов</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={useLongTermMemory}
                  onChange={(event) => {
                    setUseLongTermMemory(event.target.checked);
                    window.localStorage.setItem('use-long-term-memory', String(event.target.checked));
                  }}
                />
                <span className="memory-switch-control" aria-hidden="true" />
              </label>
            </div>

            {pendingMemory.length > 0 && (
              <div className="pending-memory">
                <strong>Что запомнить надолго?</strong>
                <p className="pending-memory-hint">Решения и знания требуют подтверждения. Важные сведения профиля сохраняются автоматически.</p>
                {pendingMemory.map((suggestion) => (
                  <div className="pending-memory-item" key={suggestion.id}>
                    <div>
                      <span>{memoryCategoryTitle(suggestion.candidate.category)}</span>
                      <b>{suggestion.candidate.key}</b>
                      <p>{suggestion.candidate.value}</p>
                    </div>
                    <div className="pending-memory-actions">
                      <button type="button" onClick={() => void handlePendingMemory(suggestion.id, 'approve')}>Запомнить</button>
                      <button type="button" onClick={() => void handlePendingMemory(suggestion.id, 'reject')}>Не сохранять</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {isMemoryOpen && (
              <div className="memory-settings">
                <div className="memory-settings-heading">
                  <strong>Добавить вручную</strong>
                  <span>Для опытных пользователей</span>
                </div>
                <form className="memory-form" onSubmit={handleSaveMemory}>
                  <label>
                    Где помнить
                    <select value={memoryLayer} onChange={(event) => handleMemoryLayerChange(event.target.value as MemoryLayer)}>
                      <option value="working">Только в этой задаче</option>
                      <option value="long-term">Во всех чатах</option>
                    </select>
                  </label>
                  <label>
                    Что это
                    <select value={memoryCategory} onChange={(event) => setMemoryCategory(event.target.value as MemoryCategory)}>
                      {memoryLayer === 'working' ? (
                        <><option value="goal">Цель</option><option value="constraint">Ограничение</option><option value="artifact">Материал</option><option value="note">Заметка</option></>
                      ) : (
                        <><option value="profile">О пользователе</option><option value="decision">Решение</option><option value="knowledge">Знание</option></>
                      )}
                    </select>
                  </label>
                  <label>
                    Короткое название
                    <input value={memoryKey} onChange={(event) => setMemoryKey(event.target.value)} placeholder="Например: формат ответа" maxLength={80} required />
                  </label>
                  <label className="memory-value-field">
                    Что нужно запомнить
                    <input value={memoryValue} onChange={(event) => setMemoryValue(event.target.value)} placeholder="Например: отвечать короткими списками" maxLength={2000} required />
                  </label>
                  <button type="submit" disabled={isSavingMemory}>{isSavingMemory ? 'Сохраняю…' : 'Добавить'}</button>
                </form>

                <div className="memory-entry-groups">
                  {(['working', 'long-term'] as const).map((layer) => {
                    const entries = layer === 'working' ? memory?.layers.working.entries : memory?.layers.longTerm.entries;
                    return (
                      <div className="memory-entry-group" key={layer}>
                        <strong>{layer === 'working' ? 'Для этой задачи' : 'Для всех чатов'}</strong>
                        {!entries?.length ? <span className="memory-empty">Пока ничего не сохранено</span> : entries.map((entry) => (
                          <div className="memory-entry" key={entry.id}>
                            <div><span>{memoryCategoryTitle(entry.category)}</span><b>{memoryKeyTitle(entry.key)}</b><p>{entry.value}</p></div>
                            <button type="button" onClick={() => void handleDeleteMemory(layer, entry.id)} aria-label={`Удалить ${entry.key}`}>Удалить</button>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

        <section className="chat-panel" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">Начните диалог — напишите сообщение ниже.</div>
          ) : (
            messages.map((chatMessage) => <MessageBubble key={chatMessage.id} message={chatMessage} />)
          )}
          {isLoading && (
            <article className="message agent">
              <div className="message-label">Агент</div>
              <div className="message-body muted">Готовлю ответ…</div>
            </article>
          )}
        </section>

        <form className="request-card" onSubmit={handleSubmit}>
          <div className="request-header">
            <label htmlFor="message">Сообщение</label>
            <div className="request-tools">
              <span>{message.length} символов</span>
              <label className="model-picker">
                <span>Модель</span>
                <select
                  value={selectedModel?.id ?? ''}
                  onChange={(event) => {
                    setSelectedModelId(event.target.value);
                    window.localStorage.setItem('agent-model-id', event.target.value);
                  }}
                  disabled={!config?.models.length || isLoading}
                  aria-label="Модель для запроса"
                >
                  {config?.models.map((model) => (
                    <option value={model.id} key={model.id}>{model.title} · {model.model}</option>
                  ))}
                </select>
              </label>
              <button className="reset-button" type="button" onClick={handleReset} disabled={!config || isLoading}>
                Сбросить
              </button>
            </div>
          </div>
          <textarea
            id="message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Напишите сообщение агенту"
            rows={4}
            disabled={!config || isLoading}
          />

          <div className="request-actions">
            {(configError || error) && (
              <p className="error" role="alert">
                {configError || error}
              </p>
            )}
            <button className="submit-button" type="submit" disabled={!selectedModel || Boolean(configError) || isLoading}>
              {!config ? 'Загрузка…' : isLoading ? 'Отвечаю…' : 'Отправить'}
              {!isLoading && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </form>

      </div>
      </div>
    </main>
  );
}

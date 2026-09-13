import { FormEvent, useEffect, useMemo, useState } from 'react';

type AgentResponse = {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated';
  tokenReport?: AgentTokenReport;
  cost: number | null;
  priceCurrency: string;
  elapsedMs: number;
  finishReason: string | null;
  agentName: string;
  modelTitle: string;
  model: string;
  session?: AgentSession;
  stats?: HistoryTokenStats;
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
  defaults: {
    task: string;
  };
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isAgent = message.role === 'agent';

  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">{isAgent ? 'Агент' : 'Вы'}</div>
      <div className="message-body">{message.content}</div>
      {message.meta && (
        <footer className="message-meta">
          <span>{message.meta.modelTitle}</span>
          <span>{message.meta.model}</span>
          <span>{formatDuration(message.meta.elapsedMs)}</span>
          <span>запрос: {formatTokens(message.meta.tokenReport?.currentRequestTokens)}</span>
          <span>история: {formatTokens(message.meta.tokenReport?.fullHistoryTokens)}</span>
          <span>ответ: {formatTokens(message.meta.tokenReport?.outputTokens ?? message.meta.outputTokens)}</span>
          <span>total: {formatTokens(message.meta.totalTokens)}</span>
          <span>стоимость: {formatCost(message.meta.cost, message.meta.priceCurrency)}</span>
        </footer>
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
        <footer className="message-meta">
          <span>запрос: {formatTokens(message.tokenMeta.currentRequestTokens)}</span>
          <span>вся история: {formatTokens(message.tokenMeta.fullHistoryTokens)}</span>
          <span>история в prompt: {formatTokens(message.tokenMeta.selectedHistoryTokens)}</span>
          <span>input: {formatTokens(message.tokenMeta.inputTokens)}</span>
          <span>лимит: {formatTokens(message.tokenMeta.maxContextTokens)}</span>
          <span>осталось: {formatTokens(message.tokenMeta.remainingInputTokens)}</span>
          <span>стоимость input: {formatCost(message.tokenMeta.estimatedInputCost, message.tokenMeta.priceCurrency)}</span>
        </footer>
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

  const flashModel = useMemo(() => config?.models.find((model) => model.id === 'flash'), [config]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadInitialData() {
      try {
        const sessionQuery = new URLSearchParams({ sessionId }).toString();
        const [configResponse, chatsResponse, historyResponse] = await Promise.all([
          fetch('/api/config', { signal: controller.signal }),
          fetch('/api/agent/chats', { signal: controller.signal }),
          fetch(`/api/agent/history?${sessionQuery}`, { signal: controller.signal })
        ]);
        const data = (await configResponse.json()) as AppConfig;

        if (!configResponse.ok) {
          throw new Error('Не удалось загрузить конфигурацию.');
        }

        setConfig(data);
        setMessage(data.defaults.task);

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
    setMessage(config?.defaults.task ?? '');
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
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось очистить историю агента.');
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
          sessionId
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
              <span className={`api-status ${flashModel ? 'ready' : 'pending'}`}>
                <span className="status-dot" /> {flashModel ? flashModel.model : 'Подключение'}
              </span>
              <button type="button" onClick={handleNewChat}>
                Новый чат
              </button>
            </div>
          </header>

          {(flashModel || historyStats) && (
            <section className={`compact-metrics ${historyStats?.willOverflowOnNextSmallRequest ? 'overflow' : ''}`} aria-label="Лимиты и статистика">
              {flashModel && (
                <>
                  <span>Провайдер: <strong>{flashModel.provider}</strong></span>
                  <span>Контекст: <strong>{formatTokens(flashModel.maxContextTokens)}</strong></span>
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

        <section className="chat-panel" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">Ответ агента появится здесь после первого запроса.</div>
          ) : (
            messages.map((chatMessage) => <MessageBubble key={chatMessage.id} message={chatMessage} />)
          )}
          {isLoading && (
            <article className="message agent">
              <div className="message-label">Агент</div>
              <div className="message-body muted">Думаю и вызываю LLM API...</div>
            </article>
          )}
        </section>

        <form className="request-card" onSubmit={handleSubmit}>
          <div className="request-header">
            <label htmlFor="message">Запрос пользователя</label>
            <div className="request-tools">
              <span>{message.length} символов</span>
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
            <button className="submit-button" type="submit" disabled={!flashModel || Boolean(configError) || isLoading}>
              {!config ? 'Загрузка настроек...' : isLoading ? 'Агент отвечает...' : 'Отправить агенту'}
              {!isLoading && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </form>

      </div>
      </div>
    </main>
  );
}

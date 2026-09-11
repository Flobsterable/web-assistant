import { FormEvent, useEffect, useMemo, useState } from 'react';

type AgentResponse = {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenSource: 'api' | 'estimated';
  cost: number | null;
  priceCurrency: string;
  elapsedMs: number;
  finishReason: string | null;
  agentName: string;
  modelTitle: string;
  model: string;
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
  meta?: AgentResponse;
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

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
          <span>total: {message.meta.totalTokens ?? '-'}</span>
          <span>стоимость: {formatCost(message.meta.cost, message.meta.priceCurrency)}</span>
        </footer>
      )}
    </article>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [configError, setConfigError] = useState('');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const flashModel = useMemo(() => config?.models.find((model) => model.id === 'flash'), [config]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch('/api/config', { signal: controller.signal });
        const data = (await response.json()) as AppConfig;

        if (!response.ok) {
          throw new Error('Не удалось загрузить конфигурацию.');
        }

        setConfig(data);
        setMessage(data.defaults.task);

        if (data.error) {
          setConfigError(`Заполните .env: ${data.error}`);
        }
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return;
        setConfigError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить конфигурацию.');
      }
    }

    void loadConfig();
    return () => controller.abort();
  }, []);

  function handleReset() {
    setMessage(config?.defaults.task ?? '');
    setMessages([]);
    setError('');
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
          message: trimmedMessage
        })
      });

      const data = (await response.json()) as AgentResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in data && data.error ? data.error : 'Не удалось получить ответ агента.');
      }

      const agentResponse = data as AgentResponse;
      setMessages((currentMessages) => [
        ...currentMessages,
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

  return (
    <main className="page-shell">
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-lockup">
            <h1>Simple LLM Agent</h1>
            <p>запрос через DeepSeek Flash</p>
          </div>
          <span className={`api-status ${flashModel ? 'ready' : 'pending'}`}>
            <span className="status-dot" /> {flashModel ? 'DeepSeek Flash подключен' : 'Подключение...'}
          </span>
        </header>

        <section className="hero">
          <div>
            <h2>Чат с отдельным агентом</h2>
            <p>Интерфейс отправляет сообщение на backend, а backend передает его агенту. Агент инкапсулирует промпт, вызов LLM и нормализацию ответа.</p>
          </div>
        </section>

        {flashModel && (
          <section className="config-summary" aria-label="Модель агента">
            <div>
              <span>Модель агента</span>
              <strong>{flashModel.model}</strong>
            </div>
            <div>
              <span>Провайдер</span>
              <strong>{flashModel.provider}</strong>
            </div>
            <div>
              <span>Endpoint</span>
              <strong>{flashModel.baseUrl}</strong>
            </div>
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
    </main>
  );
}

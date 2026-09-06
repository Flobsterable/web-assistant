import { FormEvent, useEffect, useState } from 'react';

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

type ComparisonResponse = {
  models: ModelResult[];
  comparison: CompletionResult;
};

type AppConfig = {
  defaults: {
    task: string;
  };
  models: PublicModelConfig[];
  hasApiKey: boolean;
  error?: string;
};

function getFinishLabel(finishReason: string | null) {
  if (finishReason === 'stop') return 'завершено';
  if (finishReason === 'length') return 'лимит токенов';
  return finishReason || 'не указан';
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(2)} с`;
}

function formatCost(cost: number | null, currency: string) {
  if (cost === null) return 'не указана';
  if (cost === 0) return `0 ${currency}`;
  return `${cost.toFixed(6)} ${currency}`;
}

function formatPrice(price: number | null, currency: string) {
  return price === null ? '-' : `${price} ${currency}/1M`;
}

function ResultCard({ result }: { result?: ModelResult }) {
  return (
    <article className={`result-card ${result?.id ?? ''}`}>
      <header className="card-header">
        <div>
          <h3>{result?.title ?? 'Модель'}</h3>
          <p>{result ? result.model : 'Ожидает запуска'}</p>
        </div>
        {result && <span className="result-status">готово</span>}
      </header>

      <div className={`answer ${result ? '' : 'answer-empty'}`}>
        {result ? result.answer : 'Ответ появится здесь'}
      </div>

      {result && (
        <footer className="card-meta">
          <span>время: {formatDuration(result.elapsedMs)}</span>
          <span>input: {result.inputTokens ?? '-'}</span>
          <span>output: {result.outputTokens ?? '-'}</span>
          <span>total: {result.totalTokens ?? '-'}</span>
          <span>токены: {result.tokenSource === 'api' ? 'API' : 'оценка'}</span>
          <span>стоимость: {formatCost(result.cost, result.priceCurrency)}</span>
          <span>
            цена in/out: {formatPrice(result.inputPricePerMillion, result.priceCurrency)} /{' '}
            {formatPrice(result.outputPricePerMillion, result.priceCurrency)}
          </span>
          <span>{getFinishLabel(result.finishReason)}</span>
          {result.sourceUrl && (
            <a href={result.sourceUrl} target="_blank" rel="noreferrer">
              ссылка
            </a>
          )}
        </footer>
      )}
    </article>
  );
}

function PlaceholderCard({ model }: { model: PublicModelConfig }) {
  return (
    <article className={`result-card ${model.id}`}>
      <header className="card-header">
        <div>
          <h3>{model.title}</h3>
          <p>{model.model}</p>
        </div>
      </header>
      <div className="answer answer-empty">Ответ появится здесь</div>
    </article>
  );
}

function ConfigSummary({ config }: { config?: AppConfig }) {
  if (!config?.models.length) return null;

  return (
    <div className="config-summary" aria-label="Подключенные модели">
      {config.models.map((model) => (
        <div key={model.id}>
          <span>{model.title}</span>
          <strong>{model.model}</strong>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [configError, setConfigError] = useState('');
  const [task, setTask] = useState('');
  const [comparison, setComparison] = useState<ComparisonResponse>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

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
        setTask(data.defaults.task);

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
    if (!config) return;

    setTask(config.defaults.task);
    setComparison(undefined);
    setError('');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!config?.models.length) {
      setError('Конфигурация моделей ещё не загружена.');
      return;
    }

    const trimmedTask = task.trim();

    if (!trimmedTask) {
      setError('Введите запрос.');
      return;
    }

    setIsLoading(true);
    setError('');
    setComparison(undefined);

    try {
      const response = await fetch('/api/compare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          task: trimmedTask
        })
      });

      const data = (await response.json()) as ComparisonResponse | { error?: string };

      if (!response.ok) {
        throw new Error('error' in data && data.error ? data.error : 'Не удалось получить ответы.');
      }

      setComparison(data as ComparisonResponse);
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
            <h1>Сравнение LLM</h1>
          </div>
          <span className={`api-status ${config?.models.length ? 'ready' : 'pending'}`}>
            <span className="status-dot" /> {config?.models.length ? `${config.models.length} модели подключены` : 'Подключение...'}
          </span>
        </header>

        <section className="hero">
          <div>
            <h2>Один запрос, три модели</h2>
          </div>
        </section>

        <ConfigSummary config={config} />

        <form className="request-card" onSubmit={handleSubmit}>
          <div className="request-header">
            <label htmlFor="task">Запрос</label>
            <div className="request-tools">
              <span>{task.length} символов</span>
              <button className="reset-button" type="button" onClick={handleReset} disabled={!config || isLoading}>
                Сбросить
              </button>
            </div>
          </div>
          <textarea
            id="task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="Введите один запрос для всех моделей"
            rows={5}
            disabled={!config || isLoading}
          />

          <div className="request-actions">
            {(configError || error) && (
              <p className="error" role="alert">
                {configError || error}
              </p>
            )}
            <button className="submit-button" type="submit" disabled={!config?.models.length || Boolean(configError) || isLoading}>
              {!config ? 'Загрузка настроек...' : isLoading ? 'Запросы выполняются...' : 'Сравнить'}
              {!isLoading && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </form>

        <section className="results" aria-live="polite">
          <div className="results-header">
            <h2>Результаты</h2>
            {isLoading && <span className="loading-note">API-запросы выполняются параллельно</span>}
          </div>
          <div className="result-grid">
            {comparison
              ? comparison.models.map((model) => <ResultCard key={model.id} result={model} />)
              : config?.models.map((model) => <PlaceholderCard key={model.id} model={model} />)}
          </div>

          <article className="comparison-card">
            <header className="card-header">
              <div>
                <h3>Короткий вывод</h3>
                <p>Качество ответов, скорость, токены, стоимость и ресурсоёмкость</p>
              </div>
              {comparison && <span className="result-status">готово</span>}
            </header>
            <div className={`answer ${comparison ? '' : 'answer-empty'}`}>
              {comparison ? comparison.comparison.answer : 'Вывод появится здесь'}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}

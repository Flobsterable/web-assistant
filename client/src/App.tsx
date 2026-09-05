import { FormEvent, useEffect, useState } from 'react';

type CompletionResult = {
  answer: string;
  completionTokens: number | null;
  finishReason: string | null;
};

type MethodResult = CompletionResult & {
  prompt: string;
};

type ComparisonResponse = {
  direct: MethodResult;
  stepByStep: MethodResult;
  generatedPrompt: MethodResult & {
    generatedPrompt: string;
  };
  experts: MethodResult;
  comparison: CompletionResult;
};

type AppConfig = {
  model: string;
  defaults: {
    task: string;
  };
  hasApiKey: boolean;
};

function getFinishLabel(finishReason: string | null) {
  if (finishReason === 'stop') return 'завершено';
  if (finishReason === 'length') return 'лимит токенов';
  return finishReason || 'не указан';
}

function ResultCard({
  title,
  subtitle,
  result,
  variant,
  extra
}: {
  title: string;
  subtitle: string;
  result?: MethodResult;
  variant: 'direct' | 'steps' | 'prompt' | 'experts';
  extra?: string;
}) {
  return (
    <article className={`result-card ${variant}`}>
      <header className="card-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        {result && <span className="result-status">готово</span>}
      </header>

      {extra && (
        <details className="prompt-details">
          <summary>Составленный запрос</summary>
          <div>{extra}</div>
        </details>
      )}

      <div className={`answer ${result ? '' : 'answer-empty'}`}>
        {result ? result.answer : 'Ответ появится здесь'}
      </div>

      {result && (
        <footer className="card-meta">
          <span>{result.completionTokens ?? '-'} токенов</span>
          <span>{getFinishLabel(result.finishReason)}</span>
        </footer>
      )}
    </article>
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
        const data = (await response.json()) as AppConfig | { error?: string };

        if (!response.ok || !('defaults' in data)) {
          throw new Error('Не удалось загрузить конфигурацию.');
        }

        setConfig(data);
        setTask(data.defaults.task);

        if (!data.hasApiKey) {
          setConfigError('Добавьте DEEPSEEK_API_KEY в файл .env.');
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

    if (!config) {
      setError('Конфигурация приложения ещё не загружена.');
      return;
    }

    const trimmedTask = task.trim();

    if (!trimmedTask) {
      setError('Введите задачу.');
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
            <h1>Сравнение решений</h1>
          </div>
          <span className={`api-status ${config ? 'ready' : 'pending'}`}>
            <span className="status-dot" /> {config ? config.model : 'Подключение...'}
          </span>
        </header>

        <section className="hero">
          <div>
            <h2>Проверка подходов</h2>
          </div>
          <p>Введите задачу и сравните несколько вариантов ответа.</p>
        </section>

        <form className="request-card" onSubmit={handleSubmit}>
          <div className="request-header">
            <label htmlFor="task">Задача</label>
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
            placeholder="Введите логическую, алгоритмическую или аналитическую задачу"
            rows={5}
            disabled={!config || isLoading}
          />

          <div className="request-actions">
            {(configError || error) && (
              <p className="error" role="alert">
                {configError || error}
              </p>
            )}
            <button className="submit-button" type="submit" disabled={!config || Boolean(configError) || isLoading}>
              {!config ? 'Загрузка настроек...' : isLoading ? 'Загрузка...' : 'Сравнить'}
              {!isLoading && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </form>

        <section className="results" aria-live="polite">
          <div className="results-header">
            <h2>Результаты</h2>
            {isLoading && <span className="loading-note">API-запросы выполняются</span>}
          </div>
          <div className="result-grid">
            <ResultCard
              title="Базовый вариант"
              subtitle="Короткое решение"
              result={comparison?.direct}
              variant="direct"
            />
            <ResultCard
              title="С рассуждением"
              subtitle="Разбор по шагам"
              result={comparison?.stepByStep}
              variant="steps"
            />
            <ResultCard
              title="Уточнённый запрос"
              subtitle="Решение после переформулировки"
              result={comparison?.generatedPrompt}
              variant="prompt"
              extra={comparison?.generatedPrompt.generatedPrompt}
            />
            <ResultCard
              title="Экспертная проверка"
              subtitle="Несколько точек зрения"
              result={comparison?.experts}
              variant="experts"
            />
          </div>
        </section>
      </div>
    </main>
  );
}

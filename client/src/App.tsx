import { FormEvent, useEffect, useState } from 'react';

type CompletionResult = {
  answer: string;
  completionTokens: number | null;
  finishReason: string | null;
};

type ComparisonResponse = {
  unrestricted: CompletionResult;
  controlled: CompletionResult;
};

type AppConfig = {
  model: string;
  minAllowedTokens: number;
  maxAllowedTokens: number;
  defaults: {
    prompt: string;
    format: string;
    maxTokens: number;
    stopSequence: string;
    responseFormat: 'text' | 'json_object';
    constraints: ConstraintState;
  };
  hasApiKey: boolean;
};

type ConstraintState = {
  format: boolean;
  length: boolean;
  stop: boolean;
};

function getFinishLabel(finishReason: string | null) {
  if (finishReason === 'stop') return 'stop sequence';
  if (finishReason === 'length') return 'лимит токенов';
  return finishReason || 'не указан';
}

function formatAnswer(answer: string, responseFormat: AppConfig['defaults']['responseFormat']) {
  if (responseFormat !== 'json_object') return answer;

  try {
    return JSON.stringify(JSON.parse(answer), null, 2);
  } catch {
    return answer;
  }
}

function ResultCard({
  title,
  subtitle,
  index,
  result,
  variant,
  responseFormat
}: {
  title: string;
  subtitle: string;
  index: string;
  result?: CompletionResult;
  variant: 'free' | 'controlled';
  responseFormat: AppConfig['defaults']['responseFormat'];
}) {
  return (
    <article className={`result-card ${variant}`}>
      <header className="card-header">
        <span className="card-index">{index}</span>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        {result && <span className="result-status">готово</span>}
      </header>

      <div className={`answer ${result ? '' : 'answer-empty'}`}>
        {result ? formatAnswer(result.answer, responseFormat) : 'Ответ появится здесь'}
      </div>

      {result && (
        <footer className="card-meta">
          <span>{result.completionTokens ?? '—'} токенов</span>
          <span>{getFinishLabel(result.finishReason)}</span>
        </footer>
      )}
    </article>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [configError, setConfigError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [format, setFormat] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [stopSequence, setStopSequence] = useState('');
  const [responseFormat, setResponseFormat] = useState<AppConfig['defaults']['responseFormat']>('text');
  const [constraints, setConstraints] = useState<ConstraintState>({ format: false, length: false, stop: false });
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
        setPrompt(data.defaults.prompt);
        setFormat(data.defaults.format);
        setMaxTokens(String(data.defaults.maxTokens));
        setStopSequence(data.defaults.stopSequence);
        setResponseFormat(data.defaults.responseFormat);
        setConstraints(data.defaults.constraints);

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

    setPrompt(config.defaults.prompt);
    setFormat(config.defaults.format);
    setMaxTokens(String(config.defaults.maxTokens));
    setStopSequence(config.defaults.stopSequence);
    setResponseFormat(config.defaults.responseFormat);
    setConstraints(config.defaults.constraints);
    setComparison(undefined);
    setError('');
  }

  function toggleConstraint(name: keyof ConstraintState) {
    setConstraints((current) => ({ ...current, [name]: !current[name] }));
    setError('');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!config) {
      setError('Конфигурация приложения ещё не загружена.');
      return;
    }

    const trimmedPrompt = prompt.trim();
    const trimmedFormat = format.trim();
    const parsedMaxTokens = Number(maxTokens);

    if (!trimmedPrompt) {
      setError('Введите исходный запрос.');
      return;
    }

    if (constraints.format && !trimmedFormat) {
      setError('Опишите формат ответа.');
      return;
    }

    if (
      constraints.length &&
      (!Number.isInteger(parsedMaxTokens) ||
        parsedMaxTokens < config.minAllowedTokens ||
        parsedMaxTokens > config.maxAllowedTokens)
    ) {
      setError(
        `Лимит должен быть целым числом от ${config.minAllowedTokens} до ${config.maxAllowedTokens} токенов.`
      );
      return;
    }

    if (constraints.stop && !stopSequence.trim()) {
      setError('Укажите stop sequence.');
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
          prompt: trimmedPrompt,
          format: trimmedFormat,
          maxTokens: constraints.length ? parsedMaxTokens : null,
          stopSequence: constraints.stop ? stopSequence.trim() : '',
          responseFormat,
          constraints
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

  const controlledSubtitle =
    [
      constraints.format && 'формат',
      constraints.length && 'лимит',
      constraints.stop && 'stop sequence'
    ]
      .filter(Boolean)
      .join(' + ') || 'без ограничений';

  return (
    <main className="page-shell">
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-lockup">
            <span className="brand-mark">02</span>
            <div>
              <p className="eyebrow">Mobile Developer Manager</p>
              <h1>Контроль ответа</h1>
            </div>
          </div>
          <span className={`api-status ${config ? 'ready' : 'pending'}`}>
            <span className="status-dot" /> {config ? config.model : 'Подключение...'}
          </span>
        </header>

        <section className="hero">
          <div>
            <p className="section-label">День 2</p>
            <h2>Сравнение ответов</h2>
          </div>
          <p>Один prompt, два режима.</p>
        </section>

        <form className="request-card" onSubmit={handleSubmit}>
          <div className="request-header">
            <label htmlFor="prompt">Запрос</label>
            <div className="request-tools">
              <span>{prompt.length} символов</span>
              <button className="reset-button" type="button" onClick={handleReset} disabled={!config || isLoading}>
                Сбросить
              </button>
            </div>
          </div>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Введите запрос для модели"
            rows={3}
            disabled={!config || isLoading}
          />

          <details className="constraints">
            <summary>
              <span>Ограничения ответа</span>
              <span className="summary-note">{Object.values(constraints).filter(Boolean).length} включено</span>
            </summary>
            <div className="constraint-fields">
              <div className="constraint-toggles" aria-label="Включить ограничения">
                <label className="toggle-control">
                  <input
                    type="checkbox"
                    checked={constraints.format}
                    onChange={() => toggleConstraint('format')}
                    disabled={!config || isLoading}
                  />
                  <span className="toggle" aria-hidden="true" />
                  <span>Формат</span>
                </label>
                <label className="toggle-control">
                  <input
                    type="checkbox"
                    checked={constraints.length}
                    onChange={() => toggleConstraint('length')}
                    disabled={!config || isLoading}
                  />
                  <span className="toggle" aria-hidden="true" />
                  <span>Длина</span>
                </label>
                <label className="toggle-control">
                  <input
                    type="checkbox"
                    checked={constraints.stop}
                    onChange={() => toggleConstraint('stop')}
                    disabled={!config || isLoading}
                  />
                  <span className="toggle" aria-hidden="true" />
                  <span>Stop sequence</span>
                </label>
              </div>
              <div className="format-field">
                <label htmlFor="format">Формат</label>
                <select
                  id="responseFormat"
                  aria-label="Тип формата"
                  value={responseFormat}
                  onChange={(event) => setResponseFormat(event.target.value as AppConfig['defaults']['responseFormat'])}
                  disabled={!config || isLoading || !constraints.format}
                >
                  <option value="json_object">JSON object</option>
                  <option value="text">Обычный текст</option>
                </select>
                <textarea
                  id="format"
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                  rows={3}
                  disabled={!config || isLoading || !constraints.format}
                />
              </div>
              <div className="number-field">
                <label htmlFor="maxTokens">Максимум токенов</label>
                <input
                  id="maxTokens"
                  type="number"
                  min={config?.minAllowedTokens}
                  max={config?.maxAllowedTokens}
                  step="1"
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                  disabled={!config || isLoading || !constraints.length}
                />
              </div>
              <div className="stop-field">
                <label htmlFor="stopSequence">Stop sequence</label>
                <input
                  id="stopSequence"
                  value={stopSequence}
                  onChange={(event) => setStopSequence(event.target.value)}
                  disabled={!config || isLoading || !constraints.stop}
                />
              </div>
            </div>
          </details>

          <div className="request-actions">
            {(configError || error) && <p className="error" role="alert">{configError || error}</p>}
            <button className="submit-button" type="submit" disabled={!config || Boolean(configError) || isLoading}>
              {!config ? 'Загрузка настроек...' : isLoading ? 'Загрузка...' : 'Сравнить ответы'}
              {!isLoading && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </form>

        <section className="results" aria-live="polite">
          <div className="results-header">
            <h2>Результаты</h2>
            {isLoading && <span className="loading-note">Два запроса выполняются параллельно</span>}
          </div>
          <div className="result-grid">
            <ResultCard
              index="01"
              title="Без ограничений"
              subtitle="Только исходный prompt"
              result={comparison?.unrestricted}
              variant="free"
              responseFormat="text"
            />
            <ResultCard
              index="02"
              title="С ограничениями"
              subtitle={controlledSubtitle}
              result={comparison?.controlled}
              variant="controlled"
              responseFormat={responseFormat}
            />
          </div>
        </section>
      </div>
    </main>
  );
}

import { FormEvent, MouseEvent, useEffect, useMemo, useState } from 'react';

type McpTool = { name: string; description: string | null; inputSchema: unknown };
type McpConnection = {
  id: string;
  endpoint: string;
  server: { name: string | null; version: string | null };
  tools: McpTool[];
  createdAt: string;
  updatedAt: string;
};
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
type GoogleCalendarStatus = {
  configured: boolean;
  connected: boolean;
  scope: string | null;
  redirectUri: string;
  endpoint: string;
  server: { name: string; version: string };
  tools: McpTool[];
};

const stateCopy: Record<ConnectionState, string> = {
  idle: 'Нет подключений',
  connecting: 'Подключение',
  connected: 'Подключено',
  error: 'Ошибка подключения',
};

function validPublicHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function McpSettingsScreen() {
  const [endpoint, setEndpoint] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null);
  const [calendarBusy, setCalendarBusy] = useState(false);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  );

  useEffect(() => {
    const controller = new AbortController();
    async function loadConnections() {
      try {
        const response = await fetch('/api/mcp/connections', { signal: controller.signal });
        const data = (await response.json()) as { connections?: McpConnection[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Не удалось загрузить MCP-подключения.');
        const loaded = data.connections ?? [];
        setConnections(loaded);
        setConnectionState(loaded.length > 0 ? 'connected' : 'idle');
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return;
        setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить MCP-подключения.');
        setConnectionState('error');
      } finally {
        setIsLoading(false);
      }
    }
    void loadConnections();
    return () => controller.abort();
  }, []);

  async function loadCalendarStatus() {
    const response = await fetch('/api/google-calendar/status');
    const data = (await response.json()) as GoogleCalendarStatus & { error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Не удалось проверить Google Calendar.');
    setCalendarStatus(data);
    return data;
  }

  useEffect(() => {
    void loadCalendarStatus().catch((caughtError) => {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось проверить Google Calendar.');
    });
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === 'google-calendar-connected') {
        void loadCalendarStatus();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  async function connectCalendar() {
    if (!calendarStatus?.configured) return;
    setCalendarBusy(true);
    setError(null);
    const popup = window.open('/api/google-calendar/oauth/start', 'google-calendar-oauth', 'popup,width=560,height=720');
    if (!popup) {
      setCalendarBusy(false);
      setError('Браузер заблокировал OAuth-окно. Разрешите всплывающие окна для этого сайта.');
      return;
    }
    const deadline = Date.now() + 2 * 60_000;
    const interval = window.setInterval(() => {
      void loadCalendarStatus().then((status) => {
        if (status.connected || Date.now() >= deadline || popup.closed) {
          window.clearInterval(interval);
          setCalendarBusy(false);
          if (status.connected && !popup.closed) popup.close();
        }
      }).catch(() => {
        if (Date.now() >= deadline || popup.closed) {
          window.clearInterval(interval);
          setCalendarBusy(false);
        }
      });
    }, 1000);
  }

  async function disconnectCalendar() {
    setCalendarBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/google-calendar/oauth', { method: 'DELETE' });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? 'Не удалось отключить Google Calendar.');
      }
      await loadCalendarStatus();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось отключить Google Calendar.');
    } finally {
      setCalendarBusy(false);
    }
  }

  async function connect(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const normalizedEndpoint = endpoint.trim();
    const normalizedHeaderName = headerName.trim();
    const normalizedHeaderValue = headerValue.trim();
    if (!validPublicHttpsEndpoint(normalizedEndpoint)) {
      setConnectionState('error');
      setError('Введите корректный публичный HTTPS endpoint без userinfo и fragment.');
      return;
    }
    if ((normalizedHeaderName === '') !== (normalizedHeaderValue === '')) {
      setConnectionState('error');
      setError('Укажите Header name и Header value вместе или оставьте оба поля пустыми.');
      return;
    }

    setConnectionState('connecting');
    setError(null);
    try {
      const response = await fetch('/api/mcp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: normalizedEndpoint,
          headerName: normalizedHeaderName || undefined,
          headerValue: normalizedHeaderValue || undefined,
        }),
      });
      const data = (await response.json()) as { connection?: McpConnection; error?: string };
      if (!response.ok || !data.connection) throw new Error(data.error ?? 'Не удалось подключить MCP server.');
      setConnections((current) => [data.connection as McpConnection, ...current.filter((item) => item.id !== data.connection?.id)]);
      setSelectedId(data.connection.id);
      setHeaderName('');
      setHeaderValue('');
      setConnectionState('connected');
    } catch (caughtError) {
      setConnectionState('error');
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось подключить MCP server.');
    }
  }

  async function removeConnection(event: MouseEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    setDeletingId(id);
    setError(null);
    try {
      const response = await fetch(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? 'Не удалось удалить MCP-подключение.');
      }
      setConnections((current) => {
        const next = current.filter((item) => item.id !== id);
        setConnectionState(next.length > 0 ? 'connected' : 'idle');
        return next;
      });
      if (selectedId === id) setSelectedId(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить MCP-подключение.');
      setConnectionState('error');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="mcp-settings-screen" aria-labelledby="mcp-settings-title">
      <header className="mcp-settings-header">
        <div><p className="mcp-kicker">Настройки системы</p><h1 id="mcp-settings-title">MCP connections</h1><p>Подключите публичный MCP server и просмотрите доступные инструменты.</p></div>
        <div className="mcp-header-status"><span className="mcp-active-status"><i aria-hidden="true" /> Интеграция активна</span><span className="mcp-discovery-badge">Tools enabled</span></div>
      </header>

      <div className="mcp-settings-content">
        <article className="mcp-security-notice">
          <div className="mcp-security-icon" aria-hidden="true">✓</div>
          <div><strong>Безопасный режим</strong><span className="mcp-security-required">READ ONLY CALENDAR</span><p>Встроенный календарный инструмент вызывает tools/call только с OAuth scope calendar.readonly. Для внешних HTTPS-серверов пока доступен discovery.</p></div>
        </article>

        <article className="mcp-connection-card mcp-calendar-card">
          <div className="mcp-card-heading">
            <div><p className="mcp-kicker">Встроенный MCP server</p><h2>Google Calendar</h2><p>Read-only доступ к расписанию через OAuth 2.0.</p></div>
            <span className={`mcp-state-pill mcp-state-${calendarStatus?.connected ? 'connected' : calendarStatus === null || calendarStatus.configured ? 'idle' : 'error'}`}><i aria-hidden="true" /> {calendarStatus?.connected ? 'Авторизован' : calendarStatus === null ? 'Загрузка…' : calendarStatus.configured ? 'Готов к OAuth' : 'Нужны credentials'}</span>
          </div>
          <dl className="mcp-calendar-meta">
            <div><dt>MCP endpoint</dt><dd>{calendarStatus?.endpoint ?? '/mcp/google-calendar'}</dd></div>
            <div><dt>OAuth redirect URI</dt><dd>{calendarStatus?.redirectUri ?? 'Загрузка…'}</dd></div>
            <div><dt>Scope</dt><dd>calendar.readonly</dd></div>
          </dl>
          {!calendarStatus?.configured && <div className="mcp-error-state" role="status"><div className="mcp-error-icon" aria-hidden="true">!</div><div><strong>Добавьте Google OAuth credentials</strong><p>Укажите GOOGLE_CALENDAR_CLIENT_ID и GOOGLE_CALENDAR_CLIENT_SECRET в .env, затем перезапустите backend.</p></div></div>}
          <div className="mcp-calendar-actions">
            {calendarStatus?.connected
              ? <button type="button" className="mcp-disconnect-button" disabled={calendarBusy} onClick={() => void disconnectCalendar()}>{calendarBusy ? 'Отключение…' : 'Отключить Google Calendar'}</button>
              : <button type="button" disabled={calendarBusy || !calendarStatus?.configured} onClick={() => void connectCalendar()}>{calendarBusy ? 'Ожидание OAuth…' : 'Войти через Google'}</button>}
          </div>
          {calendarStatus?.tools.map((tool) => <details className="mcp-tool-item" key={tool.name}><summary><span className="mcp-tool-item-icon" aria-hidden="true">⌁</span><span><strong>{tool.name}</strong><small>{tool.description}</small></span></summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}
        </article>

        <article className="mcp-connection-card">
          <div className="mcp-card-heading"><div><h2>Подключение к MCP</h2><p>Укажите Streamable HTTP endpoint сервера.</p></div><span className={`mcp-state-pill mcp-state-${connectionState}`}><i aria-hidden="true" /> {isLoading ? 'Загрузка' : stateCopy[connectionState]}</span></div>
          <form onSubmit={(event) => void connect(event)}>
            <label htmlFor="mcp-endpoint">Server endpoint</label>
            <div className="mcp-endpoint-row"><input id="mcp-endpoint" type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://example.com/mcp" disabled={connectionState === 'connecting'} autoComplete="off" spellCheck={false} /><button type="submit" disabled={connectionState === 'connecting' || endpoint.trim() === ''}>{connectionState === 'connecting' ? 'Подключение…' : 'Подключиться и загрузить инструменты'}</button></div>
            <div className="mcp-header-fields"><label>Header name<input value={headerName} onChange={(event) => setHeaderName(event.target.value)} placeholder="Authorization" disabled={connectionState === 'connecting'} autoComplete="off" /></label><label>Header value<input type="password" value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} placeholder="Bearer token" disabled={connectionState === 'connecting'} autoComplete="new-password" /></label></div>
            <small>Поддерживаются только публичные HTTPS endpoints. Значение header не сохраняется.</small>
          </form>
          {connectionState === 'connecting' && <div className="mcp-connection-steps" aria-live="polite"><span className="is-active"><i aria-hidden="true" /> DNS Resolve</span><span><i aria-hidden="true" /> Handshake</span><span><i aria-hidden="true" /> Read Tools</span></div>}
          {connectionState === 'error' && error && <div className="mcp-error-state" role="alert"><div className="mcp-error-icon" aria-hidden="true">!</div><div><strong>Не удалось подключиться к MCP server</strong><p>{error}</p><button type="button" onClick={() => void connect()}>Повторить попытку</button></div></div>}
        </article>

        {connections.length > 0 && <section className="mcp-saved-section" aria-label="Подключённые MCP-серверы"><div className="mcp-saved-heading"><div><h2>Подключённые сервисы</h2><p>Нажмите на сервис, чтобы открыть его инструменты.</p></div><span>{connections.length}</span></div>{connections.map((connection) => <article className={`mcp-server-summary ${selectedId === connection.id ? 'selected' : ''}`} key={connection.id} role="button" tabIndex={0} onClick={() => setSelectedId((current) => current === connection.id ? null : connection.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId((current) => current === connection.id ? null : connection.id); } }}><div className="mcp-server-icon" aria-hidden="true">◇</div><div className="mcp-server-details"><div className="mcp-server-title-row"><div><span className="mcp-connected-label"><i aria-hidden="true" /> Connected</span><h2>{connection.server.name ?? new URL(connection.endpoint).hostname}</h2></div><button type="button" className="mcp-disconnect-button" disabled={deletingId === connection.id} onClick={(event) => void removeConnection(event, connection.id)}>{deletingId === connection.id ? 'Удаление…' : 'Удалить MCP'}</button></div><dl><div><dt>Version</dt><dd>{connection.server.version ?? '—'}</dd></div><div><dt>Endpoint</dt><dd>{connection.endpoint}</dd></div><div><dt>Tools</dt><dd>{connection.tools.length}</dd></div></dl></div></article>)}</section>}

        {selectedConnection && <article className="mcp-tools-card"><div className="mcp-card-heading"><div><h2>Tools inventory · {selectedConnection.server.name ?? 'MCP server'}</h2><p>Инструменты доступны только для просмотра.</p></div><span className="mcp-tool-count">{selectedConnection.tools.length}</span></div>{selectedConnection.tools.length === 0 ? <div className="mcp-empty-state"><span aria-hidden="true">◇</span><strong>No tools available</strong><p>Сервер не вернул доступных инструментов.</p></div> : <div className="mcp-tool-list">{selectedConnection.tools.map((tool) => <details className="mcp-tool-item" key={tool.name}><summary><span className="mcp-tool-item-icon" aria-hidden="true">⌁</span><span><strong>{tool.name}</strong><small>{tool.description ?? 'Описание отсутствует.'}</small></span></summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}</div>}</article>}
      </div>
    </section>
  );
}

import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import AssistantScreen from './AssistantScreen';
import { documentAccept, formatFileSize, type StoredDocument, uploadDocument } from './documents';

type Screen = 'chat' | 'planner' | 'mcp' | 'index';
type Strategy = 'fixed' | 'structural';
type Message = { id: string; role: 'user' | 'assistant'; content: string };
type Chunk = {
  content: string; token_count: number; embedding: number[]; score?: number;
  metadata: { source: string; title: string; section: string; chunk_id: string; strategy: Strategy };
};
type StrategyStats = { chunks: number; average_chars: number; min_chars: number; max_chars: number; overlap_percent: number; sections_preserved: number };
type DocumentIndex = {
  created_at: string; embedding_model: string; embedding_dimensions: number; document_count: number;
  total_characters: number; estimated_pages: number; source_directory: string;
  settings: { fixed_size: number; fixed_overlap: number; structural_max_size: number };
  strategies: Record<Strategy, StrategyStats>; chunks: Chunk[];
};

const Icon = ({ name, size = 20 }: { name: string; size?: number }) => {
  const paths: Record<string, ReactNode> = {
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></>,
    scissors: <><circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="m8.6 8.5 11.4 7M8.6 15.5 20 8"/></>,
    sparkles: <><path d="m12 3-1.2 3.8L7 8l3.8 1.2L12 13l1.2-3.8L17 8l-3.8-1.2zM5 14l-.8 2.2L2 17l2.2.8L5 20l.8-2.2L8 17l-2.2-.8zM19 14l-.6 1.4L17 16l1.4.6L19 18l.6-1.4L21 16l-1.4-.6z"/></>,
    box: <><path d="m21 8-9-5-9 5 9 5z"/><path d="m3 8 9 5 9-5v8l-9 5-9-5z"/><path d="M12 13v8"/></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    check: <path d="m5 12 4 4L19 6"/>, arrow: <path d="m9 18 6-6-6-6"/>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};
const formatNumber = (value: number) => new Intl.NumberFormat('ru-RU').format(value);
const formatDate = (date: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(date));

function Sidebar({ screen, setScreen }: { screen: Screen; setScreen: (screen: Screen) => void }) {
  return <aside className="sidebar"><div className="brand"><div className="brand-mark"><span>Q</span></div><span>Quanta</span></div><nav className="nav" aria-label="Основная навигация"><button className={screen === 'chat' ? 'nav-item active' : 'nav-item'} onClick={() => setScreen('chat')}><Icon name="chat"/><span>Ассистент</span></button><button className={screen === 'planner' ? 'nav-item active' : 'nav-item'} onClick={() => setScreen('planner')}><Icon name="calendar"/><span>Планировщик</span></button><button className={screen === 'mcp' ? 'nav-item active' : 'nav-item'} onClick={() => setScreen('mcp')}><Icon name="settings"/><span>MCP</span></button><button className={screen === 'index' ? 'nav-item active' : 'nav-item'} onClick={() => setScreen('index')}><Icon name="database"/><span>Индексация</span></button></nav><div className="sidebar-footer"><span className="status-dot"/><div><strong>Локальный режим</strong><small>Данные остаются у вас</small></div></div></aside>;
}

function ChatScreen() {
  const [prompt, setPrompt] = useState(''); const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState(''); const [isLoading, setIsLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const value = prompt.trim(); if (!value) return;
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: value }]); setPrompt(''); setError(''); setIsLoading(true);
    try { const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: value }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось получить ответ.'); setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: data.answer }]); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Произошла ошибка.'); } finally { setIsLoading(false); }
  }
  return <section className="chat-screen"><header className="topbar"><div><p className="eyebrow">Рабочее пространство</p><h1>Ассистент</h1></div><span className="online"><span/>DeepSeek подключен</span></header><div className="chat-content"><div className="messages">{messages.length === 0 && <div className="empty-state"><div className="empty-icon"><Icon name="sparkles" size={28}/></div><h2>Чем помочь сегодня?</h2><p>Задайте вопрос. Скоро ассистент сможет использовать ваш локальный индекс как контекст.</p></div>}{messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span className="avatar">{message.role === 'user' ? 'Вы' : 'Q'}</span><div className="bubble">{message.content}</div></article>)}{isLoading && <article className="message assistant"><span className="avatar">Q</span><div className="bubble typing"><i/><i/><i/></div></article>}{error && <p className="error">{error}</p>}</div><form className="composer" onSubmit={submit}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Сообщение для Quanta…" rows={2}/><button type="submit" disabled={isLoading} aria-label="Отправить"><Icon name="arrow"/></button></form></div></section>;
}

const stages = [
  { icon: 'file', number: '01', title: 'Документы', text: 'Markdown, статьи, код и PDF преобразуются в чистый текст.' },
  { icon: 'scissors', number: '02', title: 'Разбиение', text: 'Текст делится фиксированными окнами и по смысловой структуре.' },
  { icon: 'sparkles', number: '03', title: 'Эмбеддинги', text: 'Для каждого чанка создаётся нормализованный вектор из 128 чисел.' },
  { icon: 'box', number: '04', title: 'Локальный индекс', text: 'Контент, векторы и метаданные атомарно сохраняются в JSON.' }
];
function Pipeline() { return <div className="pipeline" aria-label="Процесс индексации">{stages.map((stage, index) => <div className="stage-wrap" key={stage.number}><article className="stage"><div className="stage-top"><span className="stage-icon"><Icon name={stage.icon}/></span><small>{stage.number}</small></div><h3>{stage.title}</h3><p>{stage.text}</p></article>{index < stages.length - 1 && <span className="connector"><Icon name="chevron" size={17}/></span>}</div>)}</div>; }
function MetricCard({ label, value, note }: { label: string; value: string; note: string }) { return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }

function StrategyCard({ type, stats, settings, active, onClick }: { type: Strategy; stats: StrategyStats; settings: DocumentIndex['settings']; active: boolean; onClick: () => void }) {
  const structural = type === 'structural';
  return <button className={`strategy-card ${active ? 'selected' : ''}`} onClick={onClick}><div className="strategy-heading"><div><span className={`strategy-icon ${structural ? 'violet' : ''}`}><Icon name={structural ? 'file' : 'scissors'}/></span><div><h3>{structural ? 'По структуре' : 'Фиксированный размер'}</h3><p>{structural ? `Заголовки · максимум ${settings.structural_max_size}` : `${settings.fixed_size} символов · overlap ${settings.fixed_overlap}`}</p></div></div>{active && <span className="selected-check"><Icon name="check" size={15}/></span>}</div><div className="strategy-bars"><div><span>Размер чанка</span><b>{stats.average_chars} симв.</b></div><i><span style={{ width: structural ? '78%' : '61%' }}/></i><div><span>Сохранение контекста</span><b>{structural ? 'Высокое' : 'Среднее'}</b></div><i><span style={{ width: structural ? '91%' : '66%' }}/></i></div><div className="strategy-footer"><span><strong>{stats.chunks}</strong> чанков</span><span><strong>{stats.sections_preserved}</strong> секций</span><span><strong>{stats.overlap_percent}%</strong> overlap</span></div></button>;
}
function ChunkRow({ chunk }: { chunk: Chunk }) {
  const [expanded, setExpanded] = useState(false);
  return <article className={`chunk-row ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded(!expanded)}><div className="chunk-type"><Icon name="file" size={17}/></div><div className="chunk-main"><div className="chunk-title"><strong>{chunk.metadata.section}</strong><code>{chunk.metadata.chunk_id}</code></div><p>{chunk.content}</p>{expanded && <div className="vector"><span>embedding[0:8]</span><code>[{chunk.embedding.slice(0, 8).join(', ')}]</code></div>}</div><div className="chunk-meta"><span title={chunk.metadata.title}>{chunk.metadata.title}</span><small>{chunk.metadata.source} · {chunk.token_count} токенов{chunk.score !== undefined ? ` · ${(chunk.score * 100).toFixed(0)}%` : ''}</small></div><Icon name="chevron" size={16}/></article>;
}

function IndexScreen({ strategy, onStrategyChange }: { strategy: Strategy; onStrategyChange: (strategy: Strategy) => void }) {
  const [data, setData] = useState<DocumentIndex | null>(null);
  const [openPanel, setOpenPanel] = useState<'documents' | 'chunking' | 'strategy' | 'process' | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Chunk[] | null>(null);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [clearingDocuments, setClearingDocuments] = useState(false);
  const [settings, setSettings] = useState<DocumentIndex['settings']>({
    fixed_size: 1200,
    fixed_overlap: 180,
    structural_max_size: 1800
  });

  async function load(rebuild = false) {
    rebuild ? setRebuilding(true) : setLoading(true);
    setError('');
    try {
      const response = await fetch(rebuild ? '/api/index/rebuild' : '/api/index', {
        method: rebuild ? 'POST' : 'GET',
        headers: rebuild ? { 'Content-Type': 'application/json' } : undefined,
        body: rebuild ? JSON.stringify({ settings }) : undefined
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Индекс недоступен.');
      setData(json);
      if (json.settings) setSettings(json.settings);
      setResults(null);
      if (rebuild) setOpenPanel(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Ошибка индекса.');
    } finally {
      setLoading(false);
      setRebuilding(false);
    }
  }

  async function loadDocuments() {
    const response = await fetch('/api/documents');
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || 'Не удалось загрузить список документов.');
    setDocuments(json.documents ?? []);
  }

  async function handleDocumentFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      for (const file of Array.from(files)) await uploadDocument(file);
      await Promise.all([load(false), loadDocuments()]);
      setOpenPanel(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить документ.');
    } finally {
      setUploading(false);
    }
  }

  async function removeDocument(name: string) {
    if (!window.confirm(`Удалить «${name}» из локального хранилища и индекса?`)) return;
    const response = await fetch(`/api/documents/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const json = await response.json();
    if (!response.ok) { setError(json.error || 'Не удалось удалить документ.'); return; }
    await Promise.all([load(false), loadDocuments()]);
  }

  async function clearDocuments() {
    if (!window.confirm(`Удалить все загруженные документы (${documents.length}) и очистить оба индекса? Историю чатов и память это не затронет.`)) return;
    setClearingDocuments(true);
    setError('');
    try {
      const response = await fetch('/api/documents', { method: 'DELETE' });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Не удалось очистить документы.');
      setData(json.index);
      setDocuments([]);
      setResults(null);
      setQuery('');
      setOpenPanel(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось очистить документы.');
    } finally {
      setClearingDocuments(false);
    }
  }

  useEffect(() => { void load(); void loadDocuments().catch((caught) => setError(caught instanceof Error ? caught.message : 'Ошибка хранилища.')); }, []);
  useEffect(() => { setResults(null); }, [strategy]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) { setResults(null); return; }
    const response = await fetch('/api/index/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, strategy })
    });
    const json = await response.json();
    if (response.ok) setResults(json.results);
  }

  const visibleChunks = useMemo(
    () => results ?? data?.chunks.filter((chunk) => chunk.metadata.strategy === strategy).slice(0, 6) ?? [],
    [data, results, strategy]
  );

  if (loading) {
    return <section className="index-screen"><div className="screen-loader"><span/><p>Читаем локальный индекс…</p><small>Синтетические документы не создаются</small></div></section>;
  }

  return (
    <section className="index-screen">
      <header className="topbar index-topbar">
        <div><p className="eyebrow">База знаний</p><h1>Индексация документов</h1></div>
        <button className="rebuild-button" onClick={() => void load(true)} disabled={rebuilding}>
          <Icon name="refresh" size={17}/>{rebuilding ? 'Индексируем…' : 'Перестроить индекс'}
        </button>
      </header>
      <div className="index-content">
        {error && <p className="error">{error}</p>}
        {data && <>
          <section className="intro">
            <div><span className="kicker">ДЕНЬ 21 · ЛОКАЛЬНЫЙ RAG</span><h2>От документов —<br/>к готовому контексту</h2><p>Два способа разбиения, локальные эмбеддинги и прозрачные метаданные для каждого фрагмента.</p></div>
            <div className={`index-status ${data.document_count === 0 ? 'empty' : ''}`}><span className="success-icon"><Icon name={data.document_count === 0 ? 'file' : 'check'} size={20}/></span><div><strong>{data.document_count === 0 ? 'Ожидаем документы' : 'Индекс готов'}</strong><small>{data.document_count === 0 ? 'Добавьте первый реальный файл' : `Обновлён ${formatDate(data.created_at)}`}</small></div></div>
          </section>
          <nav className="index-controls" aria-label="Управление индексом">
            <button className={openPanel === 'documents' ? 'active' : ''} type="button" onClick={() => setOpenPanel((current) => current === 'documents' ? null : 'documents')}><Icon name="file" size={17}/><span><strong>Документы</strong><small>{documents.length} загружено</small></span><b>⌄</b></button>
            <button className={openPanel === 'chunking' ? 'active' : ''} type="button" onClick={() => setOpenPanel((current) => current === 'chunking' ? null : 'chunking')}><Icon name="scissors" size={17}/><span><strong>Параметры</strong><small>{settings.fixed_size} / {settings.structural_max_size} симв.</small></span><b>⌄</b></button>
            <button className={openPanel === 'strategy' ? 'active' : ''} type="button" onClick={() => setOpenPanel((current) => current === 'strategy' ? null : 'strategy')}><Icon name="search" size={17}/><span><strong>Стратегия агента</strong><small>{strategy === 'fixed' ? 'Фиксированный размер' : 'По структуре'}</small></span><b>⌄</b></button>
            <button className={openPanel === 'process' ? 'active' : ''} type="button" onClick={() => setOpenPanel((current) => current === 'process' ? null : 'process')}><Icon name="sparkles" size={17}/><span><strong>Как это работает</strong><small>4 этапа индексации</small></span><b>⌄</b></button>
          </nav>

          {openPanel === 'documents' && <section className="document-upload control-panel">
            <div className="upload-copy"><span className="stage-icon"><Icon name="file"/></span><div><h3>Реальные документы</h3><p>Добавьте Markdown, текст, код, HTML, JSON или PDF. Файл останется локально и сразу попадёт в индекс.</p></div></div>
            <div className="upload-actions">
              <label className={`upload-button ${uploading ? 'disabled' : ''}`}><input type="file" multiple accept={documentAccept} disabled={uploading || clearingDocuments} onChange={(event) => { void handleDocumentFiles(event.target.files); event.target.value = ''; }}/>{uploading ? 'Обрабатываем…' : 'Выбрать файлы'}</label>
              <button className="clear-documents-button" type="button" onClick={() => void clearDocuments()} disabled={documents.length === 0 || uploading || clearingDocuments}>{clearingDocuments ? 'Удаляем…' : 'Удалить все'}</button>
            </div>
            <div className="document-list">
              {documents.length === 0 ? <p className="documents-empty">Документов пока нет. Индекс пуст — синтетические данные не создаются.</p> : documents.map((document) => <article key={document.name}><span><Icon name="file" size={15}/></span><div><strong>{document.name}</strong><small>{formatFileSize(document.size)} · {formatDate(document.updatedAt)}</small></div><button type="button" onClick={() => void removeDocument(document.name)} aria-label={`Удалить ${document.name}`}>×</button></article>)}
            </div>
          </section>}

          {openPanel === 'process' && <section className="control-panel process-panel"><Pipeline/></section>}
          <section className="metrics">
            <MetricCard label="Документов" value={String(data.document_count)} note="в локальном корпусе"/>
            <MetricCard label="Объём" value={`${data.estimated_pages} стр.`} note={`${formatNumber(data.total_characters)} символов`}/>
            <MetricCard label="Эмбеддинги" value={`${data.embedding_dimensions}D`} note={data.embedding_model}/>
            <MetricCard label="Всего чанков" value={String(data.strategies.fixed.chunks + data.strategies.structural.chunks)} note="в двух индексах"/>
          </section>

          {openPanel === 'chunking' && <section className="chunk-settings control-panel">
            <div className="section-title"><div><span>01</span><div><h2>Настройка разбиения</h2><p>Параметры применяются к обоим индексам при следующей пересборке.</p></div></div><span className="hint">После применения панель закроется</span></div>
            <div className="settings-card">
              <label><span>Фиксированный размер</span><input type="number" min="300" max="6000" step="100" value={settings.fixed_size} onChange={(event) => setSettings((current) => ({ ...current, fixed_size: Number(event.target.value) }))}/><small>300–6 000 символов</small></label>
              <label><span>Перекрытие</span><input type="number" min="0" max={Math.round(settings.fixed_size * .45)} step="20" value={settings.fixed_overlap} onChange={(event) => setSettings((current) => ({ ...current, fixed_overlap: Number(event.target.value) }))}/><small>до 45% размера чанка</small></label>
              <label><span>Максимум для раздела</span><input type="number" min="500" max="8000" step="100" value={settings.structural_max_size} onChange={(event) => setSettings((current) => ({ ...current, structural_max_size: Number(event.target.value) }))}/><small>500–8 000 символов</small></label>
              <button onClick={() => void load(true)} disabled={rebuilding}><Icon name="refresh" size={17}/>{rebuilding ? 'Перестраиваем…' : 'Применить настройки'}</button>
            </div>
          </section>}

          {openPanel === 'strategy' && <section className="comparison control-panel">
            <div className="section-title"><div><span>02</span><div><h2>Стратегия поиска агента</h2><p>Выбор применяется к следующим сообщениям, вложениям и поиску по индексу.</p></div></div><span className="hint">Выбор сохранится локально</span></div>
            <div className="strategy-grid">
              <StrategyCard type="fixed" stats={data.strategies.fixed} settings={data.settings} active={strategy === 'fixed'} onClick={() => { onStrategyChange('fixed'); setOpenPanel(null); }}/>
              <StrategyCard type="structural" stats={data.strategies.structural} settings={data.settings} active={strategy === 'structural'} onClick={() => { onStrategyChange('structural'); setOpenPanel(null); }}/>
            </div>
          </section>}

          <section className="chunks section-block">
            <div className="section-title chunks-heading">
              <div><span>03</span><div><h2>Фрагменты активной стратегии</h2><p>{strategy === 'fixed' ? 'Фиксированный размер' : 'По структуре'} · эта же стратегия используется агентом.</p></div></div>
              <form className="search" onSubmit={search}><Icon name="search" size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по активной стратегии…"/><button>Найти</button></form>
            </div>
            <div className="chunk-list">
              {results && <p className="results-label">Топ-{results.length} по косинусной близости · {strategy === 'fixed' ? 'фиксированный размер' : 'по структуре'}</p>}
              {visibleChunks.map((chunk) => <ChunkRow key={chunk.metadata.chunk_id} chunk={chunk}/>)}
            </div>
          </section>
        </>}
      </div>
    </section>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const hash = window.location.hash.slice(1);
    return hash === 'index' || hash === 'planner' || hash === 'mcp' ? hash : 'chat';
  });
  const [retrievalStrategy, setRetrievalStrategy] = useState<Strategy>(() =>
    window.localStorage.getItem('retrieval-strategy') === 'fixed' ? 'fixed' : 'structural'
  );
  function changeRetrievalStrategy(next: Strategy) {
    setRetrievalStrategy(next);
    window.localStorage.setItem('retrieval-strategy', next);
  }
  function navigate(next: Screen) {
    setScreen(next);
    window.location.hash = next === 'chat' ? '' : next;
  }
  return <main className="app-shell"><Sidebar screen={screen} setScreen={navigate}/><div className="main-panel">{screen === 'index' ? <IndexScreen strategy={retrievalStrategy} onStrategyChange={changeRetrievalStrategy}/> : <AssistantScreen requestedView={screen} onViewChange={navigate} retrievalStrategy={retrievalStrategy} onRetrievalStrategyChange={changeRetrievalStrategy}/>}</div></main>;
}

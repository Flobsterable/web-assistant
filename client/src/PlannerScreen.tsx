import { useEffect, useMemo, useState } from 'react';

type Todo = {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'completed';
  priority: 'low' | 'normal' | 'high';
  dueAt: string | null;
  createdAt: string;
  completedAt: string | null;
};

type Summary = {
  id: string;
  kind: 'daily' | 'weekly';
  generatedAt: string;
  text: string;
  metrics: {
    created: number;
    completed: number;
    pending: number;
    overdue: number;
    completionRate: number;
  };
};

type PlannerState = {
  todos: Todo[];
  summaries: { daily: Summary | null; weekly: Summary | null };
  scheduler: {
    daily: { intervalMs: number; nextRunAt: string | null };
    weekly: { intervalMs: number; nextRunAt: string | null };
  };
};

const priorityNames = { low: 'Низкий', normal: 'Обычный', high: 'Высокий' } as const;

function SummaryCard({ title, summary, onOpen }: { title: string; summary: Summary | null; onOpen: () => void }) {
  return (
    <button className="planner-summary-button" type="button" onClick={onOpen} disabled={!summary}>
      <div>
        <div><small>Фоновая сводка</small><h2>{title}</h2></div>
        <span>{summary ? `Выполнено ${summary.metrics.completed} · В работе ${summary.metrics.pending}` : 'Сводка ещё формируется'}</span>
      </div>
      <b aria-hidden="true">→</b>
    </button>
  );
}

export function PlannerScreen({ profileId }: { profileId: string }) {
  const [data, setData] = useState<PlannerState | null>(null);
  const [error, setError] = useState('');
  const [openSummary, setOpenSummary] = useState<'daily' | 'weekly' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/planner/state?${new URLSearchParams({ profileId })}`, { signal: controller.signal });
        const payload = await response.json() as PlannerState & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? 'Не удалось загрузить планировщики.');
        setData(payload);
        setError('');
      } catch (cause) {
        if ((cause as Error).name !== 'AbortError') setError(cause instanceof Error ? cause.message : 'Не удалось загрузить планировщики.');
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [profileId]);

  const pending = useMemo(() => data?.todos.filter((todo) => todo.status === 'pending') ?? [], [data]);
  const completed = useMemo(() => data?.todos.filter((todo) => todo.status === 'completed') ?? [], [data]);
  const selectedSummary = openSummary ? data?.summaries[openSummary] ?? null : null;

  return (
    <section className="planner-simple-screen">
      <header className="planner-simple-header">
        <h1>Планировщики</h1>
      </header>

      {error && <div className="planner-error" role="alert">{error}</div>}

      <div className="planner-simple-layout">
        <main className="planner-simple-card planner-simple-todos">
          <div className="planner-simple-card-heading">
            <div><small>Сохранено через MCP</small><h2>Список дел</h2></div>
            <span>{pending.length} в работе</span>
          </div>
          {data === null ? <p className="planner-simple-empty">Загрузка…</p> : data.todos.length === 0 ? (
            <div className="planner-simple-empty-state">
              <strong>Список пока пуст</strong>
              <p>Напишите агенту, например: «Мои дела: купить продукты, подготовить отчёт, позвонить клиенту».</p>
            </div>
          ) : (
            <div className="planner-simple-list">
              {pending.map((todo) => (
                <article key={todo.id}>
                  <i data-priority={todo.priority} />
                  <div><strong>{todo.title}</strong>{todo.description && <p>{todo.description}</p>}</div>
                  <span>{priorityNames[todo.priority]}</span>
                  {todo.dueAt && <time>{new Date(todo.dueAt).toLocaleString('ru-RU')}</time>}
                </article>
              ))}
              {completed.length > 0 && <details><summary>Выполнено · {completed.length}</summary>{completed.map((todo) => <p key={todo.id}>{todo.title}</p>)}</details>}
            </div>
          )}
        </main>

        <aside className="planner-simple-summaries">
          <SummaryCard title="За день" summary={data?.summaries.daily ?? null} onOpen={() => setOpenSummary('daily')} />
          <SummaryCard title="За неделю" summary={data?.summaries.weekly ?? null} onOpen={() => setOpenSummary('weekly')} />
        </aside>
      </div>

      {openSummary && selectedSummary && (
        <div className="planner-summary-modal-backdrop" role="presentation" onMouseDown={() => setOpenSummary(null)}>
          <section className="planner-summary-modal" role="dialog" aria-modal="true" aria-labelledby="planner-summary-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><small>Краткая сводка</small><h2 id="planner-summary-title">{openSummary === 'daily' ? 'Итоги дня' : 'Итоги недели'}</h2></div>
              <button type="button" onClick={() => setOpenSummary(null)} aria-label="Закрыть">×</button>
            </header>
            <p className="planner-summary-report">{selectedSummary.text}</p>
            <dl>
              <div><dt>Добавлено</dt><dd>{selectedSummary.metrics.created}</dd></div>
              <div><dt>Выполнено</dt><dd>{selectedSummary.metrics.completed}</dd></div>
              <div><dt>В работе</dt><dd>{selectedSummary.metrics.pending}</dd></div>
              <div><dt>Просрочено</dt><dd>{selectedSummary.metrics.overdue}</dd></div>
            </dl>
            <time>Обновлено {new Date(selectedSummary.generatedAt).toLocaleString('ru-RU')}</time>
          </section>
        </div>
      )}
    </section>
  );
}

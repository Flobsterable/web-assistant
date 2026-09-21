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
  task?: TaskState | null;
  invariantCompliance?: InvariantCompliance;
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

type UserProfile = {
  id: string;
  name: string;
  context: string;
  style: string;
  format: string;
  constraints: string[];
  createdAt: string;
  updatedAt: string;
};

type ProfilesResponse = { profiles: UserProfile[] };

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
  personalization: {
    profileId: string;
    profileName: string;
    applied: boolean;
    tokens: number;
  };
  invariants: { items: number; tokens: number; appliedIds: string[]; mandatory: true };
};

type InvariantCategory = 'architecture' | 'technical-decision' | 'stack-constraint' | 'business-rule';
type Invariant = {
  id: string;
  category: InvariantCategory;
  title: string;
  rule: string;
  rationale: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
type InvariantsResponse = { scope: string; storage: string; invariants: Invariant[] };
type InvariantCompliance = {
  status: 'allowed' | 'conflict' | 'uncertain';
  phase: 'request' | 'response' | null;
  appliedIds: string[];
  violations: Array<{ id: string; reason: string }>;
  explanation: string;
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

type TaskPhase = 'planning' | 'execution' | 'validation' | 'done';
type TaskStatus = 'active' | 'paused' | 'done';
type TaskState = {
  id: string;
  title: string;
  phase: TaskPhase;
  currentStep: string;
  expectedAction: string;
  status: TaskStatus;
  sourceSessionId: string;
  activeSessionId: string | null;
  snapshot: { goal: string; nextSteps: string[] };
  updatedAt: string;
  lastTransitionError?: string | null;
};
type TasksResponse = { profileId: string; tasks: TaskState[] };

const taskPhaseTitles: Record<TaskPhase, string> = {
  planning: 'Планирование', execution: 'Выполнение', validation: 'Проверка', done: 'Готово'
};

const taskStatusTitles: Record<TaskStatus, string> = {
  active: 'В работе', paused: 'На паузе', done: 'Завершена'
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
    'task.stage': 'Этап задачи',
    'task.current_step': 'Текущий шаг',
    'task.expected_action': 'Ожидаемое действие',
    'task.validation': 'Результат проверки',
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
            <span>Профиль: {message.meta.contextManagement.personalization.applied ? message.meta.contextManagement.personalization.profileName : 'не применён'}</span>
            <span>
              Инварианты: {message.meta.contextManagement.invariants.appliedIds.length > 0
                ? `${message.meta.contextManagement.invariants.appliedIds.length}, применены обязательно`
                : 'не заданы'}
            </span>
            <span>Проверка: {message.meta.invariantCompliance?.status === 'allowed' ? 'соблюдены' : message.meta.invariantCompliance?.status ?? '—'}</span>
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
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [memoryLayer, setMemoryLayer] = useState<MemoryLayer>('working');
  const [memoryCategory, setMemoryCategory] = useState<MemoryCategory>('goal');
  const [memoryKey, setMemoryKey] = useState('');
  const [memoryValue, setMemoryValue] = useState('');
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);
  const [useWorkingMemory, setUseWorkingMemory] = useState(() => readMemoryToggle('use-working-memory'));
  const [useLongTermMemory, setUseLongTermMemory] = useState(() => readMemoryToggle('use-long-term-memory'));
  const [selectedModelId, setSelectedModelId] = useState(() => window.localStorage.getItem('agent-model-id') ?? 'flash');
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState(() => window.localStorage.getItem('agent-profile-id') ?? 'default');
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileContext, setProfileContext] = useState('');
  const [profileStyle, setProfileStyle] = useState('');
  const [profileFormat, setProfileFormat] = useState('');
  const [profileConstraints, setProfileConstraints] = useState('');
  const [invariants, setInvariants] = useState<Invariant[]>([]);
  const [invariantCategory, setInvariantCategory] = useState<InvariantCategory>('architecture');
  const [invariantTitle, setInvariantTitle] = useState('');
  const [invariantRule, setInvariantRule] = useState('');
  const [invariantRationale, setInvariantRationale] = useState('');
  const [isSavingInvariant, setIsSavingInvariant] = useState(false);

  const selectedModel = useMemo(
    () => config?.models.find((model) => model.id === selectedModelId) ?? config?.models[0],
    [config, selectedModelId]
  );
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0],
    [profiles, selectedProfileId]
  );
  const currentTask = useMemo(
    () => tasks.find((task) => task.status === 'active' && task.activeSessionId === sessionId),
    [tasks, sessionId]
  );

  useEffect(() => {
    if (!selectedProfile || isCreatingProfile) return;
    setProfileName(selectedProfile.name);
    setProfileContext(selectedProfile.context);
    setProfileStyle(selectedProfile.style);
    setProfileFormat(selectedProfile.format);
    setProfileConstraints(selectedProfile.constraints.join('\n'));
  }, [selectedProfile, isCreatingProfile]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadInitialData() {
      try {
        const sessionQuery = new URLSearchParams({ sessionId }).toString();
        const memoryQuery = new URLSearchParams({ sessionId, profileId: selectedProfileId }).toString();
        const [configResponse, profilesResponse, chatsResponse, historyResponse, memoryResponse, pendingResponse, tasksResponse, invariantsResponse] = await Promise.all([
          fetch('/api/config', { signal: controller.signal }),
          fetch('/api/profiles', { signal: controller.signal }),
          fetch('/api/agent/chats', { signal: controller.signal }),
          fetch(`/api/agent/history?${sessionQuery}`, { signal: controller.signal }),
          fetch(`/api/agent/memory?${memoryQuery}`, { signal: controller.signal }),
          fetch(`/api/agent/memory/pending?${memoryQuery}`, { signal: controller.signal }),
          fetch(`/api/tasks?${new URLSearchParams({ profileId: selectedProfileId })}`, { signal: controller.signal }),
          fetch('/api/invariants', { signal: controller.signal })
        ]);
        const data = (await configResponse.json()) as AppConfig;

        if (!configResponse.ok) {
          throw new Error('Не удалось загрузить конфигурацию.');
        }

        setConfig(data);
        if (profilesResponse.ok) {
          const loadedProfiles = ((await profilesResponse.json()) as ProfilesResponse).profiles;
          setProfiles(loadedProfiles);
          if (!loadedProfiles.some((profile) => profile.id === selectedProfileId)) {
            setSelectedProfileId('default');
            window.localStorage.setItem('agent-profile-id', 'default');
          }
        }
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
        if (tasksResponse.ok) setTasks(((await tasksResponse.json()) as TasksResponse).tasks);
        if (invariantsResponse.ok) setInvariants(((await invariantsResponse.json()) as InvariantsResponse).invariants);

      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return;
        setConfigError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить конфигурацию.');
      }
    }

    void loadInitialData();
    return () => controller.abort();
  }, [sessionId, selectedProfileId]);

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

  async function handleNewChat() {
    const nextSessionId = createSessionId();
    setError('');
    if (currentTask) {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(currentTask.id)}/pause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: selectedProfileId })
        });
        const data = (await response.json()) as { task?: TaskState; error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Не удалось поставить текущую задачу на паузу.');
        if (data.task) {
          setTasks((current) => current.map((task) => task.id === data.task?.id ? data.task as TaskState : task));
        }
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : 'Не удалось поставить текущую задачу на паузу.');
      }
    }
    openChat(nextSessionId);
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
    const query = new URLSearchParams({ sessionId, profileId: selectedProfileId }).toString();
    const [response, pendingResponse, tasksResponse] = await Promise.all([
      fetch(`/api/agent/memory?${query}`),
      fetch(`/api/agent/memory/pending?${query}`),
      fetch(`/api/tasks?${new URLSearchParams({ profileId: selectedProfileId })}`)
    ]);
    if (!response.ok || !pendingResponse.ok || !tasksResponse.ok) throw new Error('Не удалось загрузить память.');
    setMemory((await response.json()) as MemoryResponse);
    setPendingMemory(((await pendingResponse.json()) as PendingMemoryResponse).suggestions);
    setTasks(((await tasksResponse.json()) as TasksResponse).tasks);
  }

  async function handleOpenTask(task: TaskState) {
    setError('');
    if (task.status === 'done') {
      openChat(task.sourceSessionId);
      return;
    }
    try {
      const taskSessionId = task.activeSessionId ?? task.sourceSessionId ?? createSessionId();
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: taskSessionId, profileId: selectedProfileId })
      });
      const data = (await response.json()) as { task?: TaskState; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Не удалось продолжить задачу.');
      if (data.task) {
        setTasks((current) => current.map((item) => item.id === data.task?.id ? data.task as TaskState : item));
      }
      openChat(taskSessionId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось продолжить задачу.');
    }
  }

  async function handlePendingMemory(id: string, action: 'approve' | 'reject') {
    setError('');
    try {
      const response = await fetch(`/api/agent/memory/pending/${encodeURIComponent(id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, profileId: selectedProfileId })
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
          profileId: selectedProfileId,
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

  async function refreshInvariants() {
    const response = await fetch('/api/invariants');
    const data = (await response.json()) as InvariantsResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Не удалось загрузить инварианты.');
    setInvariants(data.invariants);
  }

  async function handleSaveInvariant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setIsSavingInvariant(true);
    try {
      const response = await fetch('/api/invariants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: invariantCategory,
          title: invariantTitle,
          rule: invariantRule,
          rationale: invariantRationale,
          enabled: true
        })
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Не удалось сохранить инвариант.');
      setInvariantTitle('');
      setInvariantRule('');
      setInvariantRationale('');
      await refreshInvariants();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить инвариант.');
    } finally {
      setIsSavingInvariant(false);
    }
  }

  async function handleToggleInvariant(invariant: Invariant) {
    setError('');
    try {
      const response = await fetch(`/api/invariants/${encodeURIComponent(invariant.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...invariant, enabled: !invariant.enabled })
      });
      if (!response.ok) throw new Error('Не удалось изменить инвариант.');
      await refreshInvariants();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось изменить инвариант.');
    }
  }

  async function handleDeleteInvariant(id: string) {
    setError('');
    try {
      const response = await fetch(`/api/invariants/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Не удалось удалить инвариант.');
      await refreshInvariants();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить инвариант.');
    }
  }

  async function handleDeleteMemory(layer: MemoryLayer, id: string) {
    setError('');
    const query = new URLSearchParams({ sessionId, profileId: selectedProfileId }).toString();
    try {
      const response = await fetch(`/api/agent/memory/${layer}/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Не удалось удалить запись памяти.');
      await refreshMemory();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить запись памяти.');
    }
  }

  function handleNewProfile() {
    setIsMemoryOpen(true);
    setIsCreatingProfile(true);
    setProfileName('');
    setProfileContext('');
    setProfileStyle('');
    setProfileFormat('');
    setProfileConstraints('');
  }

  async function handleSaveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const body = {
      name: profileName,
      context: profileContext,
      style: profileStyle,
      format: profileFormat,
      constraints: profileConstraints.split('\n').map((item) => item.trim()).filter(Boolean)
    };
    try {
      const response = await fetch(isCreatingProfile ? '/api/profiles' : `/api/profiles/${encodeURIComponent(selectedProfileId)}`, {
        method: isCreatingProfile ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = (await response.json()) as { profile?: UserProfile; error?: string };
      if (!response.ok || !data.profile) throw new Error(data.error ?? 'Не удалось сохранить профиль.');
      setProfiles((current) => [...current.filter((profile) => profile.id !== data.profile?.id), data.profile as UserProfile]);
      setSelectedProfileId(data.profile.id);
      window.localStorage.setItem('agent-profile-id', data.profile.id);
      setIsCreatingProfile(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить профиль.');
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
          profileId: selectedProfileId,
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

          <section className="sidebar-tasks" aria-label="Сохранённые задачи">
            <div className="sidebar-tasks-header">
              <div><span>Долгосрочная память</span><strong>Задачи</strong></div>
              <b>{tasks.length}</b>
            </div>
            <div className="sidebar-task-list">
              {tasks.length === 0 ? (
                <p className="chat-list-empty">Отложенных задач пока нет.</p>
              ) : tasks.map((task) => (
                <button
                  className={`sidebar-task-item ${task.activeSessionId === sessionId ? 'active' : ''}`}
                  type="button"
                  onClick={() => void handleOpenTask(task)}
                  key={task.id}
                >
                  <span className="sidebar-task-title">{task.title}</span>
                  <span className="sidebar-task-meta">
                    <i data-status={task.status}>{taskStatusTitles[task.status]}</i>
                    <small>{taskPhaseTitles[task.phase]}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
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

          {currentTask && (
            <section className="current-task-panel" aria-label="Текущая задача">
              <div className="task-state-heading">
                <div><small>Текущая задача</small><strong>{currentTask.title}</strong></div>
                <span data-status={currentTask.status}>{taskStatusTitles[currentTask.status]}</span>
              </div>
              <div className="task-stage-track" aria-label={`Этап: ${taskPhaseTitles[currentTask.phase]}`}>
                {(['planning', 'execution', 'validation', 'done'] as const).map((phase) => (
                  <span className={phase === currentTask.phase ? 'current' : ''} key={phase}>{taskPhaseTitles[phase]}</span>
                ))}
              </div>
              <dl className="task-state-details">
                <div><dt>Текущий шаг</dt><dd>{currentTask.currentStep}</dd></div>
                <div><dt>Ожидаемое действие</dt><dd>{currentTask.expectedAction}</dd></div>
              </dl>
              {currentTask.lastTransitionError && (
                <p className="task-transition-error" role="alert">{currentTask.lastTransitionError}</p>
              )}
            </section>
          )}

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
            <div className="memory-toolbar">
              <div className="memory-summary" aria-label="Состояние памяти">
                <div><strong>{memory?.layers.shortTerm.messages.length ?? messages.length}</strong><span>сообщений</span></div>
                <div><strong>{memory?.layers.working.entries.length ? 'Готов' : '—'}</strong><span>контекст</span></div>
                <div><strong>{memory?.layers.longTerm.entries.length ?? 0}</strong><span>надолго</span></div>
                <div><strong>{invariants.filter((item) => item.enabled).length}</strong><span>инвариантов</span></div>
                {pendingMemory.length > 0 && <div className="attention"><strong>{pendingMemory.length}</strong><span>ждёт решения</span></div>}
              </div>
              <button
                className="memory-toggle"
                type="button"
                aria-expanded={isMemoryOpen}
                onClick={() => setIsMemoryOpen((isOpen) => !isOpen)}
              >
                {isMemoryOpen ? 'Скрыть' : 'Настройки'}
                <span aria-hidden="true">{isMemoryOpen ? '↑' : '↓'}</span>
              </button>
            </div>

            <div className="profile-selector">
              <label>
                <span><strong>Профиль пользователя</strong><small>Данные о человеке и его предпочтения</small></span>
                <select
                  value={selectedProfileId}
                  onChange={(event) => {
                    setIsCreatingProfile(false);
                    setSelectedProfileId(event.target.value);
                    window.localStorage.setItem('agent-profile-id', event.target.value);
                  }}
                >
                  {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <button type="button" onClick={handleNewProfile}>Новый пользователь</button>
            </div>

            <div className="memory-switches" aria-label="Использование памяти в ответах">
              <button
                type="button"
                role="switch"
                aria-checked={useWorkingMemory}
                title="Сжатый контекст текущей задачи"
                onClick={() => {
                  const nextValue = !useWorkingMemory;
                  setUseWorkingMemory(nextValue);
                  window.localStorage.setItem('use-working-memory', String(nextValue));
                }}
              >
                <strong>Рабочая</strong>
                <span className="memory-switch-control" aria-hidden="true" />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={useLongTermMemory}
                title="Персональные сведения из всех чатов"
                onClick={() => {
                  const nextValue = !useLongTermMemory;
                  setUseLongTermMemory(nextValue);
                  window.localStorage.setItem('use-long-term-memory', String(nextValue));
                }}
              >
                <strong>Долговременная</strong>
                <span className="memory-switch-control" aria-hidden="true" />
              </button>
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
                <div className="profile-editor">
                  <div className="memory-settings-heading">
                    <strong>{isCreatingProfile ? 'Новый пользователь' : `Пользователь: ${selectedProfile?.name ?? ''}`}</strong>
                    <span>Личные сведения и предпочтения пользователя</span>
                  </div>
                  <form className="profile-form" onSubmit={handleSaveProfile}>
                    <label>Имя пользователя<input value={profileName} onChange={(event) => setProfileName(event.target.value)} required maxLength={80} placeholder="Например: Александр" /></label>
                    <label className="profile-context">О пользователе <small>Роль, опыт, сфера, интересы и цели</small><textarea value={profileContext} onChange={(event) => setProfileContext(event.target.value)} rows={3} maxLength={4000} required placeholder="Например: frontend-разработчик, изучает React, работает над SaaS-продуктом" /></label>
                    <label>Как удобно получать ответы <small>необязательно</small><input value={profileStyle} onChange={(event) => setProfileStyle(event.target.value)} maxLength={1000} placeholder="Например: кратко и нейтрально" /></label>
                    <label>Предпочтительный формат <small>необязательно</small><input value={profileFormat} onChange={(event) => setProfileFormat(event.target.value)} maxLength={1000} placeholder="Например: 3–5 пунктов" /></label>
                    <label className="profile-constraints">Что учитывать <small>необязательно, по одному на строку</small><textarea value={profileConstraints} onChange={(event) => setProfileConstraints(event.target.value)} rows={3} placeholder="Не любит эмодзи" /></label>
                    <button type="submit">{isCreatingProfile ? 'Создать пользователя' : 'Сохранить'}</button>
                  </form>
                </div>
                <div className="invariant-editor">
                  <div className="memory-settings-heading">
                    <strong>Инварианты</strong>
                    <span>Добавлять необязательно. Если активные инварианты заданы, ассистент обязан применять их во всех ответах</span>
                  </div>
                  <form className="memory-form" onSubmit={handleSaveInvariant}>
                    <label>
                      Категория
                      <select value={invariantCategory} onChange={(event) => setInvariantCategory(event.target.value as InvariantCategory)}>
                        <option value="architecture">Архитектура</option>
                        <option value="technical-decision">Техническое решение</option>
                        <option value="stack-constraint">Ограничение стека</option>
                        <option value="business-rule">Бизнес-правило</option>
                      </select>
                    </label>
                    <label>
                      Название
                      <input value={invariantTitle} onChange={(event) => setInvariantTitle(event.target.value)} placeholder="Например: Только TypeScript" maxLength={120} required />
                    </label>
                    <label className="memory-value-field">
                      Правило
                      <input value={invariantRule} onChange={(event) => setInvariantRule(event.target.value)} placeholder="Не использовать JavaScript без типизации" maxLength={2000} required />
                    </label>
                    <label className="memory-value-field">
                      Почему это важно <small>необязательно</small>
                      <input value={invariantRationale} onChange={(event) => setInvariantRationale(event.target.value)} placeholder="Причина или контекст решения" maxLength={1000} />
                    </label>
                    <button type="submit" disabled={isSavingInvariant}>{isSavingInvariant ? 'Сохраняю…' : 'Добавить инвариант'}</button>
                  </form>
                  {invariants.length > 0 && (
                    <div className="memory-entry-group">
                      {invariants.map((invariant) => (
                        <div className={`memory-entry ${invariant.enabled ? '' : 'disabled'}`} key={invariant.id}>
                          <div>
                            <span>{invariant.category}</span>
                            <b>{invariant.title}</b>
                            <p>{invariant.rule}</p>
                          </div>
                          <div className="pending-memory-actions">
                            <button type="button" onClick={() => void handleToggleInvariant(invariant)}>{invariant.enabled ? 'Отключить' : 'Включить'}</button>
                            <button type="button" onClick={() => void handleDeleteInvariant(invariant.id)}>Удалить</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {invariants.length === 0 && (
                    <p className="invariant-empty">Инварианты не заданы — ассистент работает без этого слоя ограничений.</p>
                  )}
                </div>
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

                {Boolean(memory?.layers.working.entries.length || memory?.layers.longTerm.entries.length) && (
                  <div className="memory-entry-groups">
                    {(['working', 'long-term'] as const).map((layer) => {
                      const entries = layer === 'working' ? memory?.layers.working.entries : memory?.layers.longTerm.entries;
                      if (!entries?.length) return null;
                      return (
                        <div className="memory-entry-group" key={layer}>
                          <strong>{layer === 'working' ? 'Для этой задачи' : 'Для всех чатов'}</strong>
                          {entries.map((entry) => (
                            <div className="memory-entry" key={entry.id}>
                              <div><span>{memoryCategoryTitle(entry.category)}</span><b>{memoryKeyTitle(entry.key)}</b><p>{entry.value}</p></div>
                              <button type="button" onClick={() => void handleDeleteMemory(layer, entry.id)} aria-label={`Удалить ${entry.key}`}>Удалить</button>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
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

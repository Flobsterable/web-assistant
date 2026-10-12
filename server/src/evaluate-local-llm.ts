import dotenv from 'dotenv';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGroundingMessage, validateGroundedAnswer } from './grounded-answer.js';
import { buildIndex } from './indexer.js';
import {
  inspectOllamaModel,
  requestOllamaCompletion,
  type OllamaGenerationSettings,
  type OllamaModelInfo
} from './ollama-client.js';
import { runRagRetrieval } from './rag-pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

type EvaluationCase = {
  question: string;
  rewrite: string;
  expectedFacts: string[];
};

type BenchmarkProfile = {
  id: 'baseline' | 'optimized';
  title: string;
  model: string;
  prompt: string;
  settings: OllamaGenerationSettings;
};

type RunResult = {
  caseId: number;
  repetition: number;
  quality: number;
  factCoverage: number;
  validJson: boolean;
  grounded: boolean;
  correctAbstention: boolean;
  wallTimeMs: number;
  tokensPerSecond: number | null;
  inputTokens: number;
  outputTokens: number;
  answer: string;
};

const cases: EvaluationCase[] = [
  { question: 'Какой внутренний код проекта «Аврора» и кто им руководит?', rewrite: 'проект Аврора внутренний код руководитель', expectedFacts: ['KOBALT-731', 'Соколов'] },
  { question: 'Когда пройдут пилот и промышленный запуск?', rewrite: 'проект Аврора даты пилота и промышленного запуска', expectedFacts: ['6 сентября 2027', '17 ноября 2027'] },
  { question: 'Какие компоненты участвуют в запросе от браузера до модели прогнозирования?', rewrite: 'Аврора путь запроса браузер интерфейс API шлюз модель прогнозирования', expectedFacts: ['Northstar', 'Borealis', 'Helios', 'прямой доступ запрещ'] },
  { question: 'Во сколько пересчитывается прогноз и сколько занимает полный пересчёт?', rewrite: 'Аврора время ежедневного пересчёта прогноза длительность полного пересчёта', expectedFacts: ['02:40', '38 минут'] },
  { question: 'Каков бюджет проекта и размер управленческого резерва?', rewrite: 'Аврора бюджет проекта размер управленческого резерва', expectedFacts: ['84,6', '7,2'] },
  { question: 'Кто может разрешить расходование резерва?', rewrite: 'Аврора кто согласует расходование управленческого резерва', expectedFacts: ['Соколов', 'Беляев'] },
  { question: 'Каковы RTO, RPO и целевая доступность?', rewrite: 'Аврора RTO RPO целевая доступность системы', expectedFacts: ['45 минут', '12 минут', '99,93'] },
  { question: 'Что делать при SEV-1 и когда подготовить разбор?', rewrite: 'Аврора действия при SEV-1 уведомление срок разбора инцидента', expectedFacts: ['#aurora-war-room', 'Ветров', '10 минут', '3 рабочих дня'] },
  { question: 'Какие источники данных используются и как часто они обновляются?', rewrite: 'Аврора источники данных частота обновления Меридиан Метеоконтур Трасса Полярис', expectedFacts: ['Меридиан', '15 минут', 'Метеоконтур', '3 часа', 'Трасса', '01:20', 'Полярис', 'вручную'] },
  { question: 'Где находится московский офис проекта «Аврора»?', rewrite: 'Аврора московский офис адрес', expectedFacts: [] },
  { question: 'Кто согласует расходование резерва и кого уведомляют при критическом инциденте?', rewrite: 'Аврора согласование управленческого резерва уведомление при SEV-1', expectedFacts: ['Соколов', 'Беляев', 'Ветров'] }
];

const optimizedPrompt = [
  'Ты ассистент по внутренним документам.',
  'Для документальных фактов используй только RAG_CONTEXT.',
  'Не дополняй ответ знаниями из памяти модели и не угадывай.',
  'Верни только требуемый JSON, без markdown и пояснений.',
  'Пиши кратко по-русски. Сохраняй имена, даты, числа и идентификаторы точно.',
  'Если подтверждения нет, верни пустой answer и пустой список citations.'
].join('\n');

function textEnv(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required.`);
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function optionalNumberEnv(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function normalize(value: string) {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .replace(/\./g, ',')
    .trim();
}

function parseJsonAnswer(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(fenced.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatBytes(value: number | null) {
  if (value === null) return 'н/д';
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function profileSummary(profile: BenchmarkProfile, runs: RunResult[], modelInfo: OllamaModelInfo | null) {
  const throughputs = runs.flatMap((run) => run.tokensPerSecond === null ? [] : [run.tokensPerSecond]);
  return {
    id: profile.id,
    title: profile.title,
    model: profile.model,
    settings: profile.settings,
    modelInfo,
    qualityPercent: round(average(runs.map((run) => run.quality)) * 100, 1),
    factCoveragePercent: round(average(runs.map((run) => run.factCoverage)) * 100, 1),
    validJsonPercent: round(average(runs.map((run) => Number(run.validJson))) * 100, 1),
    groundedPercent: round(average(runs.map((run) => Number(run.grounded))) * 100, 1),
    medianLatencyMs: percentile(runs.map((run) => run.wallTimeMs), 0.5),
    p95LatencyMs: percentile(runs.map((run) => run.wallTimeMs), 0.95),
    averageTokensPerSecond: round(average(throughputs), 1),
    averageInputTokens: round(average(runs.map((run) => run.inputTokens)), 0),
    averageOutputTokens: round(average(runs.map((run) => run.outputTokens)), 0)
  };
}

async function runProfile(profile: BenchmarkProfile, index: Awaited<ReturnType<typeof buildIndex>>, repetitions: number) {
  await requestOllamaCompletion({
    baseUrl,
    apiKey,
    model: profile.model,
    messages: [{ role: 'user', content: 'Ответь одним словом: готов.' }],
    settings: {
      ...profile.settings,
      maxOutputTokens: profile.settings.maxOutputTokens === null || profile.settings.maxOutputTokens === undefined
        ? 16
        : Math.min(16, profile.settings.maxOutputTokens)
    }
  });

  const results: RunResult[] = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const item = cases[caseIndex];
    const retrieval = runRagRetrieval({
      index,
      originalQuery: item.question,
      rewrittenQuery: item.rewrite,
      strategy: 'structural',
      mode: 'improved'
    });
    const groundingMessage = createGroundingMessage(retrieval.active.selected);

    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const completion = await requestOllamaCompletion({
        baseUrl,
        apiKey,
        model: profile.model,
        messages: [
          { role: 'system', content: profile.prompt },
          groundingMessage,
          { role: 'user', content: item.question }
        ],
        settings: profile.settings,
        json: true
      });
      const payload = parseJsonAnswer(completion.answer);
      const answer = typeof payload?.answer === 'string' ? payload.answer : '';
      const validJson = payload !== null && typeof payload.answer === 'string' && Array.isArray(payload.citations);
      const factCoverage = item.expectedFacts.length === 0
        ? 1
        : item.expectedFacts.filter((fact) => normalize(answer).includes(normalize(fact))).length / item.expectedFacts.length;
      const validation = validateGroundedAnswer(completion.answer, retrieval.active.selected, retrieval.config.relevanceThreshold);
      const grounded = validation.status === 'grounded';
      const correctAbstention = item.expectedFacts.length === 0 && validJson && !answer.trim() && (payload?.citations as unknown[]).length === 0;
      const quality = item.expectedFacts.length === 0
        ? Number(correctAbstention) * 0.8 + Number(validJson) * 0.2
        : factCoverage * 0.7 + Number(grounded) * 0.2 + Number(validJson) * 0.1;
      results.push({
        caseId: caseIndex + 1,
        repetition,
        quality,
        factCoverage,
        validJson,
        grounded,
        correctAbstention,
        wallTimeMs: completion.wallTimeMs,
        tokensPerSecond: completion.tokensPerSecond,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        answer: completion.answer
      });
      console.log(`[${profile.id}] вопрос ${caseIndex + 1}/${cases.length}, повтор ${repetition}/${repetitions}: ${completion.wallTimeMs} мс`);
    }
  }
  return results;
}

function markdownReport(report: {
  createdAt: string;
  repetitions: number;
  baseline: ReturnType<typeof profileSummary>;
  optimized: ReturnType<typeof profileSummary>;
  runs: Record<BenchmarkProfile['id'], RunResult[]>;
}) {
  const { baseline, optimized } = report;
  const qualityDelta = round(optimized.qualityPercent - baseline.qualityPercent, 1);
  const speedup = optimized.medianLatencyMs > 0 ? round(baseline.medianLatencyMs / optimized.medianLatencyMs, 2) : 0;
  const setting = (value: number | null | undefined) => value ?? 'по умолчанию Ollama';
  const perCaseRows = cases.map((item, index) => {
    const caseId = index + 1;
    const before = report.runs.baseline.filter((run) => run.caseId === caseId);
    const after = report.runs.optimized.filter((run) => run.caseId === caseId);
    return `| ${caseId}. ${item.question} | ${round(average(before.map((run) => run.quality)) * 100, 1)}% | ${round(average(after.map((run) => run.quality)) * 100, 1)}% |`;
  });
  const quantizationCompared = baseline.model !== optimized.model ||
    (baseline.modelInfo?.quantizationLevel && optimized.modelInfo?.quantizationLevel && baseline.modelInfo.quantizationLevel !== optimized.modelInfo.quantizationLevel);
  return [
    '# Сравнение локальной LLM: до и после оптимизации',
    '',
    `Дата: ${report.createdAt}`,
    `Повторов каждого вопроса: ${report.repetitions}`,
    '',
    '| Метрика | До оптимизации | После оптимизации |',
    '|---|---:|---:|',
    `| Модель | ${baseline.model} | ${optimized.model} |`,
    `| Квантование | ${baseline.modelInfo?.quantizationLevel ?? 'н/д'} | ${optimized.modelInfo?.quantizationLevel ?? 'н/д'} |`,
    `| Качество | ${baseline.qualityPercent}% | ${optimized.qualityPercent}% |`,
    `| Покрытие фактов | ${baseline.factCoveragePercent}% | ${optimized.factCoveragePercent}% |`,
    `| Валидный JSON | ${baseline.validJsonPercent}% | ${optimized.validJsonPercent}% |`,
    `| Валидный grounded-ответ | ${baseline.groundedPercent}% | ${optimized.groundedPercent}% |`,
    `| Медиана задержки | ${baseline.medianLatencyMs} мс | ${optimized.medianLatencyMs} мс |`,
    `| p95 задержки | ${baseline.p95LatencyMs} мс | ${optimized.p95LatencyMs} мс |`,
    `| Скорость генерации | ${baseline.averageTokensPerSecond} ток/с | ${optimized.averageTokensPerSecond} ток/с |`,
    `| Средний вход | ${baseline.averageInputTokens} токенов | ${optimized.averageInputTokens} токенов |`,
    `| Средний ответ | ${baseline.averageOutputTokens} токенов | ${optimized.averageOutputTokens} токенов |`,
    `| Размер в памяти | ${formatBytes(baseline.modelInfo?.sizeBytes ?? null)} | ${formatBytes(optimized.modelInfo?.sizeBytes ?? null)} |`,
    `| VRAM | ${formatBytes(baseline.modelInfo?.sizeVramBytes ?? null)} | ${formatBytes(optimized.modelInfo?.sizeVramBytes ?? null)} |`,
    '',
    '## Качество по контрольным вопросам',
    '',
    '| Вопрос | До | После |',
    '|---|---:|---:|',
    ...perCaseRows,
    '',
    '## Параметры',
    '',
    `- До: прежний общий prompt; temperature=${baseline.settings.temperature}; num_ctx=${setting(baseline.settings.contextWindow)}; num_predict=${setting(baseline.settings.maxOutputTokens)}; top_p=${setting(baseline.settings.topP)}; seed=${setting(baseline.settings.seed)}.`,
    `- После: специализированный prompt для RAG; temperature=${optimized.settings.temperature}; num_ctx=${setting(optimized.settings.contextWindow)}; num_predict=${setting(optimized.settings.maxOutputTokens)}; top_p=${setting(optimized.settings.topP)}; seed=${setting(optimized.settings.seed)}.`,
    `- Квантование: ${quantizationCompared ? 'сравнивается по фактическим данным Ollama /api/show.' : 'не изменилось; для проверки укажите разные установленные теги baseline и optimized.'}`,
    '',
    '## Вывод',
    '',
    `Изменение качества: ${qualityDelta >= 0 ? '+' : ''}${qualityDelta} п.п. Медианное ускорение: ${speedup}×.`,
    qualityDelta < -3
      ? 'Оптимизированный профиль не проходит порог качества: потеря превышает 3 п.п. Следует использовать менее агрессивное квантование или увеличить контекст.'
      : 'Оптимизированный профиль проходит допустимый порог качества (потеря не более 3 п.п.).'
  ].join('\n');
}

const baseUrl = textEnv('MODEL_LOCAL_BASE_URL');
const apiKey = process.env.MODEL_LOCAL_API_KEY?.trim() || null;
const defaultModel = textEnv('MODEL_LOCAL_NAME');
const repetitions = Math.max(1, Math.floor(numberEnv('LOCAL_LLM_BENCHMARK_REPETITIONS', 3)));
const agentDefinition = await readFile(path.resolve(process.cwd(), 'agents/simple-agent.md'), 'utf8');
const baselinePrompt = agentDefinition.split('## System Prompt')[1]?.trim() || 'Ты LLM-агент. Отвечай на русском языке.';
const profiles: BenchmarkProfile[] = [
  {
    id: 'baseline',
    title: 'До оптимизации',
    model: textEnv('MODEL_LOCAL_BASELINE_NAME', defaultModel),
    prompt: baselinePrompt,
    settings: {
      temperature: numberEnv('MODEL_LOCAL_BASELINE_TEMPERATURE', 0.2),
      contextWindow: optionalNumberEnv('MODEL_LOCAL_BASELINE_CONTEXT_WINDOW'),
      maxOutputTokens: optionalNumberEnv('MODEL_LOCAL_BASELINE_MAX_OUTPUT_TOKENS'),
      topP: null,
      seed: null
    }
  },
  {
    id: 'optimized',
    title: 'После оптимизации',
    model: textEnv('MODEL_LOCAL_OPTIMIZED_NAME', defaultModel),
    prompt: optimizedPrompt,
    settings: {
      temperature: numberEnv('MODEL_LOCAL_OPTIMIZED_TEMPERATURE', 0.1),
      contextWindow: numberEnv('MODEL_LOCAL_OPTIMIZED_CONTEXT_WINDOW', 8192),
      maxOutputTokens: numberEnv('MODEL_LOCAL_OPTIMIZED_MAX_OUTPUT_TOKENS', 600),
      topP: numberEnv('MODEL_LOCAL_OPTIMIZED_TOP_P', 0.9),
      seed: numberEnv('MODEL_LOCAL_OPTIMIZED_SEED', 42)
    }
  }
];

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'local-llm-benchmark-'));
try {
  const documentsDirectory = path.join(temporaryRoot, 'documents');
  await mkdir(documentsDirectory);
  const fixturesDirectory = path.resolve(process.cwd(), '../rag-test-data');
  const documentNames = ['01-aurora-overview.md', '02-aurora-architecture.md', '03-aurora-budget.md', '04-aurora-operations.md'];
  await Promise.all(documentNames.map((name) => copyFile(path.join(fixturesDirectory, name), path.join(documentsDirectory, name))));
  const index = await buildIndex(documentsDirectory, path.join(temporaryRoot, 'index.json'));
  const allRuns: Record<BenchmarkProfile['id'], RunResult[]> = { baseline: [], optimized: [] };
  const modelInfo: Record<BenchmarkProfile['id'], OllamaModelInfo | null> = { baseline: null, optimized: null };

  for (const profile of profiles) {
    allRuns[profile.id] = await runProfile(profile, index, repetitions);
    try {
      modelInfo[profile.id] = await inspectOllamaModel(baseUrl, profile.model, apiKey);
    } catch (error) {
      console.warn(`Не удалось прочитать параметры модели ${profile.model}:`, error);
    }
  }

  const baseline = profileSummary(profiles[0], allRuns.baseline, modelInfo.baseline);
  const optimized = profileSummary(profiles[1], allRuns.optimized, modelInfo.optimized);
  const report = {
    createdAt: new Date().toISOString(),
    corpus: 'Аврора',
    questions: cases.length,
    repetitions,
    baseline,
    optimized,
    runs: allRuns
  };
  const reportsDirectory = path.resolve(process.cwd(), 'data/benchmarks');
  await mkdir(reportsDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportsDirectory, 'local-llm-latest.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(reportsDirectory, 'local-llm-latest.md'), `${markdownReport(report)}\n`)
  ]);
  console.table([baseline, optimized].map((summary) => ({
    profile: summary.title,
    model: summary.model,
    quantization: summary.modelInfo?.quantizationLevel ?? 'н/д',
    quality: `${summary.qualityPercent}%`,
    median: `${summary.medianLatencyMs} мс`,
    p95: `${summary.p95LatencyMs} мс`,
    speed: `${summary.averageTokensPerSecond} ток/с`,
    VRAM: formatBytes(summary.modelInfo?.sizeVramBytes ?? null)
  })));
  console.log(`Отчёт сохранён: ${path.join(reportsDirectory, 'local-llm-latest.md')}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

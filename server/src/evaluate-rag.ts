import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from './indexer.js';
import { runRagRetrieval, type RagResultSet } from './rag-pipeline.js';

type EvaluationCase = {
  question: string;
  rewrite: string;
  relevantSources: string[];
};

const cases: EvaluationCase[] = [
  {
    question: 'Какой внутренний код проекта «Аврора» и кто им руководит?',
    rewrite: 'проект Аврора внутренний код руководитель',
    relevantSources: ['01-aurora-overview.md']
  },
  {
    question: 'Когда пройдут пилот и промышленный запуск?',
    rewrite: 'проект Аврора даты пилота и промышленного запуска',
    relevantSources: ['01-aurora-overview.md']
  },
  {
    question: 'Какие компоненты участвуют в запросе от браузера до модели прогнозирования?',
    rewrite: 'Аврора путь запроса браузер интерфейс API шлюз модель прогнозирования',
    relevantSources: ['02-aurora-architecture.md']
  },
  {
    question: 'Во сколько пересчитывается прогноз и сколько занимает полный пересчёт?',
    rewrite: 'Аврора время ежедневного пересчёта прогноза длительность полного пересчёта',
    relevantSources: ['02-aurora-architecture.md']
  },
  {
    question: 'Каков бюджет проекта и размер управленческого резерва?',
    rewrite: 'Аврора бюджет проекта размер управленческого резерва',
    relevantSources: ['03-aurora-budget.md']
  },
  {
    question: 'Кто может разрешить расходование резерва?',
    rewrite: 'Аврора кто согласует расходование управленческого резерва',
    relevantSources: ['01-aurora-overview.md', '03-aurora-budget.md']
  },
  {
    question: 'Каковы RTO, RPO и целевая доступность?',
    rewrite: 'Аврора RTO RPO целевая доступность системы',
    relevantSources: ['04-aurora-operations.md']
  },
  {
    question: 'Что делать при SEV-1 и когда подготовить разбор?',
    rewrite: 'Аврора действия при SEV-1 уведомление срок разбора инцидента',
    relevantSources: ['04-aurora-operations.md']
  },
  {
    question: 'Какие источники данных используются и как часто они обновляются?',
    rewrite: 'Аврора источники данных частота обновления Меридиан Метеоконтур Трасса Полярис',
    relevantSources: ['02-aurora-architecture.md']
  },
  {
    question: 'Где находится московский офис проекта «Аврора»?',
    rewrite: 'Аврора московский офис адрес',
    relevantSources: []
  },
  {
    question: 'Кто согласует расходование резерва и кого уведомляют при критическом инциденте?',
    rewrite: 'Аврора согласование управленческого резерва уведомление при SEV-1',
    relevantSources: ['01-aurora-overview.md', '03-aurora-budget.md', '04-aurora-operations.md']
  }
];

function scoreResult(result: RagResultSet, relevantSources: string[]) {
  const selectedSources = result.selected.map((match) => match.metadata.source);
  if (relevantSources.length === 0) {
    const correctRejection = selectedSources.length === 0 ? 1 : 0;
    return { precision: correctRejection, recall: correctRejection, reciprocalRank: correctRejection };
  }

  const relevantSelected = selectedSources.filter((source) => relevantSources.includes(source));
  const firstRelevantIndex = selectedSources.findIndex((source) => relevantSources.includes(source));
  return {
    precision: selectedSources.length === 0 ? 0 : relevantSelected.length / selectedSources.length,
    recall: new Set(relevantSelected).size / relevantSources.length,
    reciprocalRank: firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1)
  };
}

function percentage(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'aurora-rag-evaluation-'));
const documents = path.join(root, 'documents');
const fixtures = path.resolve(process.cwd(), '../rag-test-data');
const fileNames = [
  '01-aurora-overview.md',
  '02-aurora-architecture.md',
  '03-aurora-budget.md',
  '04-aurora-operations.md'
];

try {
  await mkdir(documents);
  await Promise.all(fileNames.map((fileName) =>
    copyFile(path.join(fixtures, fileName), path.join(documents, fileName))
  ));
  const index = await buildIndex(documents, path.join(root, 'index.json'));
  const rows = cases.map((item, caseIndex) => {
    const retrieval = runRagRetrieval({
      index,
      originalQuery: item.question,
      rewrittenQuery: item.rewrite,
      strategy: 'structural',
      mode: 'compare'
    });
    const baseline = scoreResult(retrieval.baseline, item.relevantSources);
    const improved = scoreResult(retrieval.improved, item.relevantSources);
    return {
      id: caseIndex + 1,
      baseline,
      improved,
      baselineCharacters: retrieval.baseline.selected.reduce((sum, match) => sum + match.content.length, 0),
      improvedCharacters: retrieval.improved.selected.reduce((sum, match) => sum + match.content.length, 0),
      baselineSources: retrieval.baseline.selected.map((match) => match.metadata.source),
      improvedSources: retrieval.improved.selected.map((match) => match.metadata.source),
      expectedSources: item.relevantSources
    };
  });

  const positiveRows = rows.filter((row) => row.expectedSources.length > 0);
  const noAnswerRows = rows.filter((row) => row.expectedSources.length === 0);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const summary = {
    baseline: {
      precisionAtK: average(positiveRows.map((row) => row.baseline.precision)),
      recallAtK: average(positiveRows.map((row) => row.baseline.recall)),
      mrr: average(positiveRows.map((row) => row.baseline.reciprocalRank)),
      noAnswerAccuracy: average(noAnswerRows.map((row) => row.baseline.recall)),
      averageContextCharacters: average(rows.map((row) => row.baselineCharacters))
    },
    improved: {
      precisionAtK: average(positiveRows.map((row) => row.improved.precision)),
      recallAtK: average(positiveRows.map((row) => row.improved.recall)),
      mrr: average(positiveRows.map((row) => row.improved.reciprocalRank)),
      noAnswerAccuracy: average(noAnswerRows.map((row) => row.improved.recall)),
      averageContextCharacters: average(rows.map((row) => row.improvedCharacters))
    }
  };

  console.table(rows.map((row) => ({
    question: row.id,
    expected: row.expectedSources.join(', ') || 'NO ANSWER',
    baseline: row.baselineSources.join(', ') || '—',
    improved: row.improvedSources.join(', ') || '—'
  })));
  console.table([
    {
      mode: 'baseline',
      'precision@K': percentage(summary.baseline.precisionAtK),
      'recall@K': percentage(summary.baseline.recallAtK),
      MRR: summary.baseline.mrr.toFixed(3),
      'no-answer accuracy': percentage(summary.baseline.noAnswerAccuracy),
      'avg context chars': Math.round(summary.baseline.averageContextCharacters)
    },
    {
      mode: 'improved',
      'precision@K': percentage(summary.improved.precisionAtK),
      'recall@K': percentage(summary.improved.recallAtK),
      MRR: summary.improved.mrr.toFixed(3),
      'no-answer accuracy': percentage(summary.improved.noAnswerAccuracy),
      'avg context chars': Math.round(summary.improved.averageContextCharacters)
    }
  ]);

  if (summary.improved.precisionAtK <= summary.baseline.precisionAtK ||
      summary.improved.noAnswerAccuracy <= summary.baseline.noAnswerAccuracy) {
    throw new Error('Improved RAG did not beat baseline on precision and no-answer accuracy.');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

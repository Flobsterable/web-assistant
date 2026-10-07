import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { answerMeaningMatchesCitations, formatGroundedAnswer, isPersonalWriteTool, validateGroundedAnswer } from './grounded-answer.js';
import { buildIndex } from './indexer.js';
import type { RagMatch } from './rag-pipeline.js';

type GroundingCase = {
  question: string;
  answer: string;
  evidence: Array<{ source: string; quote: string }>;
};

const cases: GroundingCase[] = [
  {
    question: 'Какой внутренний код проекта «Аврора» и кто им руководит?',
    answer: 'Внутренний код проекта — KOBALT-731, руководитель — Марина Соколова.',
    evidence: [{ source: '01-aurora-overview.md', quote: 'Внутренний код проекта — **KOBALT-731**. Руководитель проекта — **Марина Соколова**.' }]
  },
  {
    question: 'Когда пройдут пилот и промышленный запуск?',
    answer: 'Пилот начинается 6 сентября 2027 года, промышленный запуск запланирован на 17 ноября 2027 года.',
    evidence: [{ source: '01-aurora-overview.md', quote: 'Контрольная дата промышленного запуска — **17 ноября 2027 года**. Пилот начинается 6 сентября 2027 года' }]
  },
  {
    question: 'Какие компоненты участвуют в запросе от браузера до модели прогнозирования?',
    answer: 'Запрос идёт из Northstar через Borealis в Helios; прямой доступ браузера к Helios запрещён.',
    evidence: [{ source: '02-aurora-architecture.md', quote: 'Northstar обращается только к Borealis. Прямой доступ браузера к Helios и CedarDB запрещён. Borealis проверяет права пользователя и добавляет идентификатор запроса, после чего передаёт задачу в Helios.' }]
  },
  {
    question: 'Во сколько пересчитывается прогноз и сколько занимает полный пересчёт?',
    answer: 'Прогноз пересчитывается ежедневно в 02:40 по омскому времени, полный пересчёт занимает около 38 минут.',
    evidence: [{ source: '02-aurora-architecture.md', quote: 'Helios пересчитывает прогноз ежедневно в **02:40 по омскому времени**. Полный пересчёт занимает около 38 минут.' }]
  },
  {
    question: 'Каков бюджет проекта и размер управленческого резерва?',
    answer: 'Бюджет — 84,6 млн рублей, управленческий резерв — 7,2 млн рублей.',
    evidence: [{ source: '03-aurora-budget.md', quote: 'Бюджет проекта на 2027 год составляет **84,6 млн рублей**. Из них 46,0 млн предназначены для разработки, 18,4 млн — для инфраструктуры, 13,0 млн — для внедрения и обучения, 7,2 млн составляют управленческий резерв.' }]
  },
  {
    question: 'Кто может разрешить расходование резерва?',
    answer: 'Расходование резерва совместно согласуют Марина Соколова и Антон Беляев.',
    evidence: [{ source: '03-aurora-budget.md', quote: 'Расходование управленческого резерва возможно только при совместном согласовании Марины Соколовой и Антона Беляева.' }]
  },
  {
    question: 'Каковы RTO, RPO и целевая доступность?',
    answer: 'RTO — 45 минут, RPO — 12 минут, целевая доступность — 99,93% в месяц.',
    evidence: [
      { source: '04-aurora-operations.md', quote: 'Целевой уровень доступности промышленной системы — **99,93% в месяц**.' },
      { source: '04-aurora-operations.md', quote: 'Параметры восстановления: **RTO — 45 минут**, **RPO — 12 минут**.' }
    ]
  },
  {
    question: 'Что делать при SEV-1 и когда подготовить разбор?',
    answer: 'Нужно координироваться в #aurora-war-room, уведомить Илью Ветрова не позднее 10 минут и опубликовать разбор за 3 рабочих дня.',
    evidence: [
      { source: '04-aurora-operations.md', quote: 'Основной канал координации инцидентов — **#aurora-war-room**. Первичным дежурным является команда Platform North. При инциденте уровня SEV-1 технический руководитель Илья Ветров должен быть уведомлён не позднее чем через 10 минут после регистрации.' },
      { source: '04-aurora-operations.md', quote: 'После SEV-1 разбор должен быть опубликован в течение 3 рабочих дней.' }
    ]
  },
  {
    question: 'Какие источники данных используются и как часто они обновляются?',
    answer: 'Меридиан обновляется каждые 15 минут, Метеоконтур — каждые 3 часа, Трасса — ежедневно в 01:20, Полярис — вручную.',
    evidence: [{ source: '02-aurora-architecture.md', quote: 'ERP «Меридиан» — остатки и заказы, обновление каждые 15 минут;\n- сервис «Метеоконтур» — прогноз погоды, обновление каждые 3 часа;\n- реестр «Трасса» — графики перевозчиков, обновление ежедневно в 01:20;\n- справочник «Полярис» — характеристики складов, обновление вручную владельцем данных.' }]
  },
  {
    question: 'Кто согласует расходование резерва и кого уведомляют при критическом инциденте?',
    answer: 'Резерв согласуют Марина Соколова и Антон Беляев; при SEV-1 уведомляют Илью Ветрова не позднее чем через 10 минут.',
    evidence: [
      { source: '03-aurora-budget.md', quote: 'Расходование управленческого резерва возможно только при совместном согласовании Марины Соколовой и Антона Беляева.' },
      { source: '04-aurora-operations.md', quote: 'При инциденте уровня SEV-1 технический руководитель Илья Ветров должен быть уведомлён не позднее чем через 10 минут после регистрации.' }
    ]
  }
];

test('10 RAG answers contain verified sources, exact quotes and matching meaning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grounded-rag-'));
  const documents = path.join(root, 'documents');
  const fixtures = path.resolve(process.cwd(), '../rag-test-data');
  const fileNames = ['01-aurora-overview.md', '02-aurora-architecture.md', '03-aurora-budget.md', '04-aurora-operations.md'];

  try {
    await mkdir(documents);
    await Promise.all(fileNames.map((fileName) => copyFile(path.join(fixtures, fileName), path.join(documents, fileName))));
    const index = await buildIndex(documents, path.join(root, 'index.json'));
    const structuralChunks = index.chunks.filter((chunk) => chunk.metadata.strategy === 'structural');

    for (const item of cases) {
      const matches = item.evidence.map(({ source, quote }): RagMatch => {
        const normalizedNeedle = quote.replace(/\s+/g, ' ').replace(/[*_`~]/g, '').toLocaleLowerCase('ru-RU');
        const chunk = structuralChunks.find((candidate) =>
          candidate.metadata.source === source &&
          candidate.content.replace(/\s+/g, ' ').replace(/[*_`~]/g, '').toLocaleLowerCase('ru-RU').includes(normalizedNeedle)
        );
        assert.ok(chunk, `Не найден чанк для вопроса: ${item.question}`);
        return { ...chunk, score: 1, relevanceScore: 1 };
      });
      const rawAnswer = JSON.stringify({
        answer: item.answer,
        citations: item.evidence.map((evidence, index) => ({
          chunk_id: matches[index].metadata.chunk_id,
          quote: evidence.quote
        }))
      });
      const result = validateGroundedAnswer(rawAnswer, matches);

      assert.equal(result.status, 'grounded', item.question);
      if (result.status !== 'grounded') continue;
      assert.ok(result.citations.length > 0, item.question);
      assert.ok(result.citations.every((citation) => citation.source && citation.section && citation.chunkId), item.question);
      assert.ok(result.citations.every((citation) => citation.quote.length > 0), item.question);
      assert.equal(answerMeaningMatchesCitations(result.answer, result.citations), true, item.question);
      const formatted = formatGroundedAnswer(result);
      assert.match(formatted, /Источники:\n- .+chunk_id:/, item.question);
      assert.match(formatted, /Цитаты:\n- «.+»/, item.question);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('weak context and an invented quote force the explicit unknown mode', () => {
  const noMatches = validateGroundedAnswer('{"answer":"Москва","citations":[]}', []);
  assert.equal(noMatches.status, 'unknown');
  assert.match(formatGroundedAnswer(noMatches), /Не знаю/);
  assert.match(formatGroundedAnswer(noMatches), /Пожалуйста, уточните вопрос/);

  const fakeMatch: RagMatch = {
    content: 'Бюджет проекта составляет 84,6 млн рублей.',
    metadata: { source: 'budget.md', title: 'Бюджет', section: 'Финансы', chunk_id: 'budget-1', strategy: 'structural' },
    embedding: [], token_count: 7, score: 0.9, relevanceScore: 0.9
  };
  const invented = validateGroundedAnswer(JSON.stringify({
    answer: 'Бюджет составляет 100 млн рублей.',
    citations: [{ chunk_id: 'budget-1', quote: 'Бюджет проекта составляет 100 млн рублей.' }]
  }), [fakeMatch]);
  assert.equal(invented.status, 'unknown');
});

test('unknown chunk ids and chunks below the relevance threshold are rejected', () => {
  const match: RagMatch = {
    content: 'RTO системы составляет 45 минут.',
    metadata: { source: 'ops.md', title: 'Эксплуатация', section: 'Восстановление', chunk_id: 'ops-1', strategy: 'structural' },
    embedding: [], token_count: 7, score: 0.9, relevanceScore: 0.21
  };
  const unknownChunk = validateGroundedAnswer(JSON.stringify({
    answer: 'RTO составляет 45 минут.',
    citations: [{ chunk_id: 'ops-invented', quote: 'RTO системы составляет 45 минут.' }]
  }), [match]);
  assert.equal(unknownChunk.status, 'unknown');

  const belowThreshold = validateGroundedAnswer(JSON.stringify({
    answer: 'RTO составляет 45 минут.',
    citations: [{ chunk_id: 'ops-1', quote: 'RTO системы составляет 45 минут.' }]
  }), [match], 0.22);
  assert.equal(belowThreshold.status, 'unknown');
});

test('read-only calendar and planner calls do not bypass RAG grounding', () => {
  assert.equal(isPersonalWriteTool('google_calendar_list_events'), false);
  assert.equal(isPersonalWriteTool('planner_list_todos'), false);
  assert.equal(isPersonalWriteTool('planner_get_summaries'), false);
  assert.equal(isPersonalWriteTool('google_calendar_create_event'), true);
  assert.equal(isPersonalWriteTool('planner_save_todos'), true);
});

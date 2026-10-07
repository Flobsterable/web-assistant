import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateGroundedAnswer } from './grounded-answer.js';
import { buildIndex, type IndexedChunk } from './indexer.js';
import type { RagMatch } from './rag-pipeline.js';
import { buildTaskMemorySearchQuery, emptyTaskMemory, extractTaskMemoryPatch, mergeTaskMemory, type TaskMemoryPatch } from './task-memory.js';

type Evidence = { source: string; quote: string };
type Turn = { message: string; patch: TaskMemoryPatch; answer?: string; evidence?: Evidence[] };

const overviewLaunch = 'Контрольная дата промышленного запуска — **17 ноября 2027 года**. Пилот начинается 6 сентября 2027 года';
const budget = 'Бюджет проекта на 2027 год составляет **84,6 млн рублей**. Из них 46,0 млн предназначены для разработки, 18,4 млн — для инфраструктуры, 13,0 млн — для внедрения и обучения, 7,2 млн составляют управленческий резерв.';
const reserveApproval = 'Расходование управленческого резерва возможно только при совместном согласовании Марины Соколовой и Антона Беляева.';
const architecture = 'Northstar обращается только к Borealis. Прямой доступ браузера к Helios и CedarDB запрещён. Borealis проверяет права пользователя и добавляет идентификатор запроса, после чего передаёт задачу в Helios.';
const dataSources = 'ERP «Меридиан» — остатки и заказы, обновление каждые 15 минут;\n- сервис «Метеоконтур» — прогноз погоды, обновление каждые 3 часа;\n- реестр «Трасса» — графики перевозчиков, обновление ежедневно в 01:20;\n- справочник «Полярис» — характеристики складов, обновление вручную владельцем данных.';
const recovery = 'Параметры восстановления: **RTO — 45 минут**, **RPO — 12 минут**.';
const availability = 'Целевой уровень доступности промышленной системы — **99,93% в месяц**.';
const sev = 'Основной канал координации инцидентов — **#aurora-war-room**. Первичным дежурным является команда Platform North. При инциденте уровня SEV-1 технический руководитель Илья Ветров должен быть уведомлён не позднее чем через 10 минут после регистрации.';

async function withIndex(run: (chunks: IndexedChunk[]) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-memory-scenario-'));
  const documents = path.join(root, 'documents');
  try {
    await mkdir(documents);
    const fixtures = path.resolve(process.cwd(), '../rag-test-data');
    const names = ['01-aurora-overview.md', '02-aurora-architecture.md', '03-aurora-budget.md', '04-aurora-operations.md'];
    await Promise.all(names.map((name) => copyFile(path.join(fixtures, name), path.join(documents, name))));
    const index = await buildIndex(documents, path.join(root, 'index.json'));
    await run(index.chunks.filter((chunk) => chunk.metadata.strategy === 'structural'));
  } finally { await rm(root, { recursive: true, force: true }); }
}

function matchEvidence(chunks: IndexedChunk[], evidence: Evidence[]): RagMatch[] {
  return evidence.map((item) => {
    const needle = item.quote.replace(/\s+/g, ' ').replace(/[*_`~]/g, '').toLocaleLowerCase('ru-RU');
    const chunk = chunks.find((candidate) => candidate.metadata.source === item.source &&
      candidate.content.replace(/\s+/g, ' ').replace(/[*_`~]/g, '').toLocaleLowerCase('ru-RU').includes(needle));
    assert.ok(chunk, `Missing fixture quote in ${item.source}`);
    return { ...chunk, score: 1, relevanceScore: 1 };
  });
}

async function runScenario(sessionId: string, turns: Turn[], chunks: IndexedChunk[]) {
  let state = emptyTaskMemory(sessionId);
  let groundedAnswers = 0;
  for (const [index, turn] of turns.entries()) {
    const patch = await extractTaskMemoryPatch({
      state,
      userMessage: turn.message,
      complete: async () => JSON.stringify(turn.patch)
    });
    state = mergeTaskMemory(state, patch, `${sessionId}-m${index + 1}`);
    const query = buildTaskMemorySearchQuery(turn.message, state);
    assert.ok(query.startsWith(`Текущий вопрос (главный приоритет): ${turn.message}`));
    if (!turn.answer || !turn.evidence) continue;
    const matches = matchEvidence(chunks, turn.evidence);
    const raw = JSON.stringify({
      answer: turn.answer,
      citations: turn.evidence.map((item, evidenceIndex) => ({
        chunk_id: matches[evidenceIndex].metadata.chunk_id,
        quote: item.quote
      }))
    });
    const grounded = validateGroundedAnswer(raw, matches, 0.22);
    assert.equal(grounded.status, 'grounded', `Turn ${index + 1}: ${turn.message}`);
    if (grounded.status === 'grounded') {
      assert.ok(grounded.citations.length > 0);
      groundedAnswers += 1;
    }
  }
  return { state, groundedAnswers };
}

test('12-turn Aurora launch scenario keeps goal, terminology and corrected constraint', async () => withIndex(async (chunks) => {
  const turns: Turn[] = [
    { message: 'Наша цель — подготовить план промышленного запуска проекта «Аврора».', patch: { goal: 'Подготовить план промышленного запуска проекта «Аврора»' } },
    { message: 'Рассматриваем только 2027 год.', patch: { facts: [{ operation: 'upsert', key: 'year', value: '2027' }] } },
    { message: 'Когда начинается пилот?', patch: {}, answer: 'Пилот начинается 6 сентября 2027 года.', evidence: [{ source: '01-aurora-overview.md', quote: overviewLaunch }] },
    { message: 'А промышленный запуск?', patch: {}, answer: 'Промышленный запуск запланирован на 17 ноября 2027 года.', evidence: [{ source: '01-aurora-overview.md', quote: overviewLaunch }] },
    { message: 'Бюджет увеличивать нельзя.', patch: { constraints: [{ operation: 'upsert', id: 'budget', value: 'Бюджет нельзя увеличивать' }] } },
    { message: 'Под «запуском» я понимаю промышленный запуск.', patch: { terminology: [{ operation: 'upsert', term: 'запуск', meaning: 'промышленный запуск' }] } },
    { message: 'Какая архитектура?', patch: {}, answer: 'Northstar обращается к Borealis, который передаёт задачу в Helios; прямой доступ браузера к Helios запрещён.', evidence: [{ source: '02-aurora-architecture.md', quote: architecture }] },
    { message: 'Какие источники данных используются?', patch: {}, answer: 'Используются Меридиан, Метеоконтур, Трасса и Полярис.', evidence: [{ source: '02-aurora-architecture.md', quote: dataSources }] },
    { message: 'Доступность должна быть не ниже 99,93%.', patch: { constraints: [{ operation: 'upsert', id: 'availability', value: 'Не ниже 99,93%' }] } },
    { message: 'Какие риски у этого варианта?', patch: { openQuestions: ['Оценить архитектурные риски'] }, answer: 'Риск — попытка прямого доступа браузера к Helios или CedarDB, который запрещён.', evidence: [{ source: '02-aurora-architecture.md', quote: architecture }] },
    { message: 'Исправление: доступность должна быть не ниже 99,95%.', patch: { constraints: [{ operation: 'upsert', id: 'availability', value: 'Не ниже 99,95%' }], openQuestions: [] } },
    { message: 'Составь итоговый план.', patch: { currentStep: 'Подготовить итоговый план' }, answer: 'План должен вести к промышленному запуску 17 ноября 2027 года и учитывать бюджет 84,6 млн рублей.', evidence: [{ source: '01-aurora-overview.md', quote: overviewLaunch }, { source: '03-aurora-budget.md', quote: budget }] }
  ];
  const { state, groundedAnswers } = await runScenario('aurora-launch', turns, chunks);
  assert.equal(turns.length, 12);
  assert.match(state.goal ?? '', /промышленного запуска/);
  assert.equal(state.terminology.find((item) => item.term === 'запуск')?.meaning, 'промышленный запуск');
  assert.equal(state.constraints.find((item) => item.id === 'availability')?.value, 'Не ниже 99,95%');
  assert.equal(state.constraints.filter((item) => item.id === 'availability').length, 1);
  assert.equal(groundedAnswers, 6);
}));

test('12-turn budget and operations scenario resolves pronoun through memory and keeps corrected constraint', async () => withIndex(async (chunks) => {
  const turns: Turn[] = [
    { message: 'Цель — подготовить решение проектного комитета по бюджету и эксплуатации Авроры.', patch: { goal: 'Подготовить решение проектного комитета по бюджету и эксплуатации Авроры' } },
    { message: 'Какой общий бюджет?', patch: {}, answer: 'Общий бюджет проекта на 2027 год — 84,6 млн рублей.', evidence: [{ source: '03-aurora-budget.md', quote: budget }] },
    { message: 'Каков резерв?', patch: {}, answer: 'Управленческий резерв составляет 7,2 млн рублей.', evidence: [{ source: '03-aurora-budget.md', quote: budget }] },
    { message: 'Бюджет запрещено увеличивать.', patch: { constraints: [{ operation: 'upsert', id: 'budget-policy', value: 'Увеличивать бюджет запрещено' }] } },
    { message: 'Кто согласует резерв?', patch: {}, answer: 'Резерв совместно согласуют Марина Соколова и Антон Беляев.', evidence: [{ source: '03-aurora-budget.md', quote: reserveApproval }] },
    { message: 'Какой RTO?', patch: {}, answer: 'RTO составляет 45 минут.', evidence: [{ source: '04-aurora-operations.md', quote: recovery }] },
    { message: 'Какой RPO?', patch: {}, answer: 'RPO составляет 12 минут.', evidence: [{ source: '04-aurora-operations.md', quote: recovery }] },
    { message: 'Что предусмотрено для SEV-1?', patch: {}, answer: 'При SEV-1 используется #aurora-war-room, а Илью Ветрова уведомляют не позднее чем через 10 минут.', evidence: [{ source: '04-aurora-operations.md', quote: sev }] },
    { message: 'Ответственным считаем Platform North.', patch: { facts: [{ operation: 'upsert', key: 'operations-owner', value: 'Platform North' }] } },
    { message: 'Изменение: бюджет можно увеличить максимум на размер резерва.', patch: { constraints: [{ operation: 'upsert', id: 'budget-policy', value: 'Увеличение допустимо максимум на размер резерва' }] } },
    { message: 'Какие эксплуатационные параметры у этого варианта?', patch: { currentStep: 'Сопоставить эксплуатационные параметры' }, answer: 'Для этого варианта RTO — 45 минут, RPO — 12 минут, доступность — 99,93% в месяц.', evidence: [{ source: '04-aurora-operations.md', quote: recovery }, { source: '04-aurora-operations.md', quote: availability }] },
    { message: 'Дай итоговую рекомендацию проектному комитету.', patch: { currentStep: 'Подготовить итоговую рекомендацию' }, answer: 'Рекомендация должна учитывать бюджет 84,6 млн рублей и совместное согласование расходования резерва Мариной Соколовой и Антоном Беляевым.', evidence: [{ source: '03-aurora-budget.md', quote: budget }, { source: '03-aurora-budget.md', quote: reserveApproval }] }
  ];
  const { state, groundedAnswers } = await runScenario('aurora-budget', turns, chunks);
  assert.equal(turns.length, 12);
  assert.match(state.goal ?? '', /проектного комитета/);
  assert.equal(state.constraints.find((item) => item.id === 'budget-policy')?.value, 'Увеличение допустимо максимум на размер резерва');
  assert.equal(state.clarifiedFacts.find((item) => item.key === 'operations-owner')?.value, 'Platform North');
  const pronounQuery = buildTaskMemorySearchQuery('Какие эксплуатационные параметры у этого варианта?', state);
  assert.match(pronounQuery, /проектного комитета/);
  assert.match(pronounQuery, /Platform North/);
  assert.equal(groundedAnswers, 8);
}));

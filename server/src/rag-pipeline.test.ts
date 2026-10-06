import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildIndex } from './indexer.js';
import { runRagRetrieval } from './rag-pipeline.js';

test('improved retrieval reranks, filters and respects top-K', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-pipeline-'));
  const documents = path.join(root, 'documents');
  await mkdir(documents);
  await writeFile(path.join(documents, 'aurora.md'), '# Аврора\n\nВнутренний код проекта KOBALT-731. Руководитель — Марина Соколова.');
  await writeFile(path.join(documents, 'cooking.md'), '# Рецепт\n\nЯблочный пирог готовят сорок минут.');

  try {
    const index = await buildIndex(documents, path.join(root, 'index.json'));
    const retrieval = runRagRetrieval({
      index,
      originalQuery: 'Какой код у проекта?',
      rewrittenQuery: 'внутренний код проекта Аврора',
      strategy: 'structural',
      mode: 'compare',
      config: { searchTopK: 2, filteredTopK: 1, relevanceThreshold: 0.1 }
    });

    assert.equal(retrieval.baseline.selected.length, 2);
    assert.equal(retrieval.improved.selected.length, 1);
    assert.equal(retrieval.improved.selected[0]?.metadata.source, 'aurora.md');
    assert.ok(retrieval.improved.averageRelevance >= retrieval.baseline.averageRelevance);
    assert.equal(retrieval.active, retrieval.improved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('threshold removes an unrelated result from the active context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-threshold-'));
  const documents = path.join(root, 'documents');
  await mkdir(documents);
  await writeFile(path.join(documents, 'aurora.md'), '# Аврора\n\nБюджет проекта составляет 84,6 млн рублей.');

  try {
    const index = await buildIndex(documents, path.join(root, 'index.json'));
    const retrieval = runRagRetrieval({
      index,
      originalQuery: 'Где находится офис в Москве?',
      rewrittenQuery: 'московский офис адрес',
      strategy: 'structural',
      mode: 'improved',
      config: { searchTopK: 4, filteredTopK: 2, relevanceThreshold: 0.5 }
    });

    assert.equal(retrieval.improved.selected.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Aurora corpus returns the expected source and rejects an absent office address', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aurora-evaluation-'));
  const documents = path.join(root, 'documents');
  const fixtures = path.resolve(process.cwd(), '../rag-test-data');
  await mkdir(documents);
  const fileNames = [
    '01-aurora-overview.md',
    '02-aurora-architecture.md',
    '03-aurora-budget.md',
    '04-aurora-operations.md'
  ];
  await Promise.all(fileNames.map((fileName) =>
    copyFile(path.join(fixtures, fileName), path.join(documents, fileName))
  ));

  try {
    const index = await buildIndex(documents, path.join(root, 'index.json'));
    const budget = runRagRetrieval({
      index,
      originalQuery: 'Каков бюджет проекта и размер управленческого резерва?',
      rewrittenQuery: 'бюджет проекта Аврора размер управленческого резерва',
      strategy: 'structural',
      mode: 'improved'
    });
    const missingOffice = runRagRetrieval({
      index,
      originalQuery: 'Где находится московский офис проекта Аврора?',
      rewrittenQuery: 'московский офис проекта Аврора адрес',
      strategy: 'structural',
      mode: 'improved'
    });

    assert.equal(budget.active.selected[0]?.metadata.source, '03-aurora-budget.md');
    assert.equal(missingOffice.active.selected.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

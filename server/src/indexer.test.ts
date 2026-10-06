import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildIndex, normalizeChunkingSettings } from './indexer.js';

test('chunking settings are validated and persisted in the index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'document-index-'));
  const documents = path.join(root, 'documents');
  const indexPath = path.join(root, 'index.json');
  await mkdir(documents);
  await writeFile(path.join(documents, 'guide.md'), `# Guide\n\n## First\n\n${'alpha beta gamma. '.repeat(120)}\n\n## Second\n\n${'delta epsilon zeta. '.repeat(120)}`);

  try {
    const index = await buildIndex(documents, indexPath, {
      fixed_size: 700,
      fixed_overlap: 100,
      structural_max_size: 900
    });

    assert.deepEqual(index.settings, {
      fixed_size: 700,
      fixed_overlap: 100,
      structural_max_size: 900
    });
    assert.ok(index.strategies.fixed.chunks > 1);
    assert.ok(index.strategies.structural.chunks > 1);
    assert.ok(index.chunks.every((chunk) => chunk.embedding.length === 128));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsafe chunking values are constrained', () => {
  assert.deepEqual(normalizeChunkingSettings({
    fixed_size: 10,
    fixed_overlap: 9999,
    structural_max_size: 50
  }), {
    fixed_size: 300,
    fixed_overlap: 135,
    structural_max_size: 500
  });
});

test('an empty storage stays empty and never creates synthetic documents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'empty-document-index-'));
  const documents = path.join(root, 'documents');
  try {
    const index = await buildIndex(documents, path.join(root, 'index.json'));
    assert.equal(index.document_count, 0);
    assert.equal(index.estimated_pages, 0);
    assert.equal(index.chunks.length, 0);
    assert.equal(index.strategies.fixed.chunks, 0);
    assert.equal(index.strategies.structural.chunks, 0);
    assert.deepEqual(await import('node:fs/promises').then(({ readdir }) => readdir(documents)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresDocumentGrounding } from './response-mode.js';

test('only explicit document questions require a grounded answer when retrieval is empty', () => {
  assert.equal(requiresDocumentGrounding('ты кто?'), false);
  assert.equal(requiresDocumentGrounding('Как устроен градиентный бустинг?'), false);
  assert.equal(requiresDocumentGrounding('Что сказано в загруженном документе?'), true);
  assert.equal(requiresDocumentGrounding('Ответь по базе знаний'), true);
  assert.equal(requiresDocumentGrounding('Объясни содержание', true), true);
});

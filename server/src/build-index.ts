import path from 'node:path';
import { buildIndex } from './indexer.js';

const dataDirectory = path.resolve(process.cwd(), 'data');
const index = await buildIndex(
  path.join(dataDirectory, 'documents'),
  path.join(dataDirectory, 'index.json')
);

console.log(JSON.stringify({
  documents: index.document_count,
  pages: index.estimated_pages,
  characters: index.total_characters,
  fixedChunks: index.strategies.fixed.chunks,
  structuralChunks: index.strategies.structural.chunks,
  dimensions: index.embedding_dimensions
}, null, 2));

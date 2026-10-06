import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildIndex } from './indexer.js';

const serverDirectory = process.cwd();
const sourceDirectory = path.resolve(serverDirectory, '../rag-test-data');
const documentsDirectory = path.resolve(serverDirectory, 'data/documents');
const indexPath = path.resolve(serverDirectory, 'data/index.json');
const files = (await readdir(sourceDirectory))
  .filter((fileName) => /^\d{2}-aurora-.*\.md$/i.test(fileName))
  .sort();

await mkdir(documentsDirectory, { recursive: true });
await Promise.all(files.map((fileName) =>
  copyFile(path.join(sourceDirectory, fileName), path.join(documentsDirectory, fileName))
));
const index = await buildIndex(documentsDirectory, indexPath);

console.log(JSON.stringify({
  copied: files,
  documents: index.document_count,
  fixedChunks: index.strategies.fixed.chunks,
  structuralChunks: index.strategies.structural.chunks,
  index: indexPath
}, null, 2));

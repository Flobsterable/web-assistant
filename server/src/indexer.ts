import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ChunkingStrategy = 'fixed' | 'structural';

export type ChunkMetadata = {
  source: string;
  title: string;
  section: string;
  chunk_id: string;
  strategy: ChunkingStrategy;
};

export type IndexedChunk = {
  content: string;
  metadata: ChunkMetadata;
  embedding: number[];
  token_count: number;
};

export type StrategyStats = {
  chunks: number;
  average_chars: number;
  min_chars: number;
  max_chars: number;
  overlap_percent: number;
  sections_preserved: number;
};

export type ChunkingSettings = {
  fixed_size: number;
  fixed_overlap: number;
  structural_max_size: number;
};

export type DocumentIndex = {
  version: 1;
  created_at: string;
  embedding_model: string;
  embedding_dimensions: number;
  document_count: number;
  total_characters: number;
  estimated_pages: number;
  source_directory: string;
  settings: ChunkingSettings;
  strategies: Record<ChunkingStrategy, StrategyStats>;
  chunks: IndexedChunk[];
};

type SourceDocument = {
  source: string;
  title: string;
  text: string;
};

type Section = {
  title: string;
  text: string;
};

const EMBEDDING_DIMENSIONS = 128;
export const DEFAULT_CHUNKING_SETTINGS: ChunkingSettings = {
  fixed_size: 1200,
  fixed_overlap: 180,
  structural_max_size: 1800
};
const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.html', '.htm', '.json', '.js', '.jsx', '.ts', '.tsx', '.css', '.py', '.pdf'
]);

export function isSupportedDocumentName(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function walk(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  }));
  return nested.flat();
}

function stripMarkup(text: string, extension: string): string {
  if (extension === '.html' || extension === '.htm') {
    return text.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  return text;
}

async function readDocument(filePath: string, root: string): Promise<SourceDocument> {
  const extension = path.extname(filePath).toLowerCase();
  let text: string;
  if (extension === '.pdf') {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], { maxBuffer: 50 * 1024 * 1024 });
    text = stdout;
  } else {
    text = stripMarkup(await fs.readFile(filePath, 'utf8'), extension);
  }
  text = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    source: path.relative(root, filePath).split(path.sep).join('/'),
    title: heading || path.basename(filePath),
    text
  };
}

function splitAtBoundary(text: string, limit: number): [string, string] {
  if (text.length <= limit) return [text, ''];
  const candidate = text.slice(0, limit);
  const paragraph = candidate.lastIndexOf('\n\n');
  const sentence = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('! '), candidate.lastIndexOf('? '));
  const whitespace = candidate.lastIndexOf(' ');
  const split = paragraph > limit * 0.55 ? paragraph : sentence > limit * 0.65 ? sentence + 1 : whitespace;
  const safeSplit = split > 0 ? split : limit;
  return [text.slice(0, safeSplit).trim(), text.slice(safeSplit).trim()];
}

function fixedChunks(document: SourceDocument, size = 1200, overlap = 180): Array<{ content: string; section: string }> {
  const chunks: Array<{ content: string; section: string }> = [];
  let cursor = 0;
  while (cursor < document.text.length) {
    const end = Math.min(cursor + size, document.text.length);
    let content = document.text.slice(cursor, end);
    if (end < document.text.length) {
      const [bounded] = splitAtBoundary(content, content.length);
      if (bounded.length > size * 0.55) content = bounded;
    }
    chunks.push({ content: content.trim(), section: `Фрагмент ${chunks.length + 1}` });
    if (cursor + content.length >= document.text.length) break;
    cursor += Math.max(content.length - overlap, 1);
  }
  return chunks.filter((chunk) => chunk.content.length > 0);
}

function extractSections(document: SourceDocument): Section[] {
  const lines = document.text.split('\n');
  const sections: Section[] = [];
  let title = 'Введение';
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) sections.push({ title, text });
    buffer = [];
  };
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      title = heading[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ title: document.title, text: document.text }];
}

function structuralChunks(document: SourceDocument, maxSize = 1800): Array<{ content: string; section: string }> {
  return extractSections(document).flatMap((section) => {
    const result: Array<{ content: string; section: string }> = [];
    let remainder = section.text;
    while (remainder.length > 0) {
      const [content, rest] = splitAtBoundary(remainder, maxSize);
      result.push({ content, section: section.title });
      remainder = rest;
    }
    return result;
  });
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function createEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = text.toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  words.forEach((word, index) => {
    const features = [word, index > 0 ? `${words[index - 1]}_${word}` : ''];
    for (const feature of features) {
      if (!feature) continue;
      const value = hash(feature);
      vector[value % EMBEDDING_DIMENSIONS] += (value & 1) === 0 ? 1 : -1;
    }
  });
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function stableId(strategy: ChunkingStrategy, source: string, index: number): string {
  return `${strategy.slice(0, 3)}-${hash(`${source}:${index}`).toString(16).padStart(8, '0')}`;
}

function indexChunks(documents: SourceDocument[], strategy: ChunkingStrategy, settings: ChunkingSettings): IndexedChunk[] {
  return documents.flatMap((document) => {
    const parts = strategy === 'fixed'
      ? fixedChunks(document, settings.fixed_size, settings.fixed_overlap)
      : structuralChunks(document, settings.structural_max_size);
    return parts.map((part, index) => ({
      content: part.content,
      metadata: {
        source: document.source,
        title: document.title,
        section: part.section,
        chunk_id: stableId(strategy, document.source, index),
        strategy
      },
      embedding: createEmbedding(part.content),
      token_count: Math.ceil(part.content.length / 4)
    }));
  });
}

function stats(chunks: IndexedChunk[], structural: boolean, settings: ChunkingSettings): StrategyStats {
  const lengths = chunks.map((chunk) => chunk.content.length);
  if (lengths.length === 0) {
    return { chunks: 0, average_chars: 0, min_chars: 0, max_chars: 0, overlap_percent: 0, sections_preserved: 0 };
  }
  return {
    chunks: chunks.length,
    average_chars: Math.round(lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1)),
    min_chars: Math.min(...lengths),
    max_chars: Math.max(...lengths),
    overlap_percent: structural ? 0 : Math.round(settings.fixed_overlap / settings.fixed_size * 100),
    sections_preserved: new Set(chunks.map((chunk) => `${chunk.metadata.source}:${chunk.metadata.section}`)).size
  };
}

export function normalizeChunkingSettings(input: Partial<ChunkingSettings> = {}): ChunkingSettings {
  const fixedSize = Math.min(6000, Math.max(300, Math.round(Number(input.fixed_size) || DEFAULT_CHUNKING_SETTINGS.fixed_size)));
  const requestedOverlap = Math.round(Number(input.fixed_overlap));
  const fixedOverlap = Number.isFinite(requestedOverlap)
    ? Math.min(Math.round(fixedSize * 0.45), Math.max(0, requestedOverlap))
    : DEFAULT_CHUNKING_SETTINGS.fixed_overlap;
  const structuralMaxSize = Math.min(8000, Math.max(500, Math.round(Number(input.structural_max_size) || DEFAULT_CHUNKING_SETTINGS.structural_max_size)));
  return { fixed_size: fixedSize, fixed_overlap: fixedOverlap, structural_max_size: structuralMaxSize };
}

export async function buildIndex(
  documentsDir: string,
  indexPath: string,
  inputSettings: Partial<ChunkingSettings> = {}
): Promise<DocumentIndex> {
  const settings = normalizeChunkingSettings(inputSettings);
  await fs.mkdir(documentsDir, { recursive: true });
  const files = (await walk(documentsDir)).filter((file) => SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const documents = (await Promise.all(files.map(async (file) => {
    try {
      return await readDocument(file, documentsDir);
    } catch (error) {
      console.warn(`Skipped ${file}:`, error);
      return null;
    }
  }))).filter((document): document is SourceDocument => Boolean(document?.text));

  const fixed = indexChunks(documents, 'fixed', settings);
  const structural = indexChunks(documents, 'structural', settings);
  const totalCharacters = documents.reduce((sum, document) => sum + document.text.length, 0);
  const index: DocumentIndex = {
    version: 1,
    created_at: new Date().toISOString(),
    embedding_model: 'local-hashing-embedding-v1',
    embedding_dimensions: EMBEDDING_DIMENSIONS,
    document_count: documents.length,
    total_characters: totalCharacters,
    estimated_pages: totalCharacters === 0 ? 0 : Math.max(1, Math.round(totalCharacters / 1800)),
    source_directory: 'server/data/documents',
    settings,
    strategies: {
      fixed: stats(fixed, false, settings),
      structural: stats(structural, true, settings)
    },
    chunks: [...fixed, ...structural]
  };

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const temporaryPath = `${indexPath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(index, null, 2), 'utf8');
  await fs.rename(temporaryPath, indexPath);
  return index;
}

export async function loadIndex(indexPath: string): Promise<DocumentIndex | null> {
  try {
    return JSON.parse(await fs.readFile(indexPath, 'utf8')) as DocumentIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

export function searchIndex(index: DocumentIndex, query: string, strategy: ChunkingStrategy, limit = 5) {
  const queryEmbedding = createEmbedding(query);
  return index.chunks
    .filter((chunk) => chunk.metadata.strategy === strategy)
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

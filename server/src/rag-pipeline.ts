import { searchIndex, type DocumentIndex, type IndexedChunk, type ChunkingStrategy } from './indexer.js';

export type RagMode = 'baseline' | 'improved' | 'compare';

export type RagConfig = {
  searchTopK: number;
  filteredTopK: number;
  relevanceThreshold: number;
};

export type RagMatch = IndexedChunk & {
  score: number;
  relevanceScore: number;
};

export type RagResultSet = {
  query: string;
  candidatesCount: number;
  selected: RagMatch[];
  averageRelevance: number;
};

export type RagRetrieval = {
  mode: RagMode;
  originalQuery: string;
  rewrittenQuery: string;
  config: RagConfig;
  baseline: RagResultSet;
  improved: RagResultSet;
  active: RagResultSet;
};

const STOP_WORDS = new Set([
  'а', 'без', 'бы', 'в', 'во', 'для', 'до', 'его', 'ее', 'её', 'если', 'и', 'из',
  'или', 'их', 'к', 'как', 'какие', 'какой', 'кто', 'на', 'не', 'но', 'о', 'об',
  'от', 'по', 'при', 'с', 'со', 'так', 'то', 'у', 'что', 'это', 'the', 'a', 'an',
  'and', 'or', 'for', 'from', 'in', 'of', 'on', 'to', 'with'
]);

export const DEFAULT_RAG_CONFIG: RagConfig = {
  searchTopK: 8,
  filteredTopK: 3,
  relevanceThreshold: 0.22
};

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function tokenize(value: string) {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .match(/[\p{L}\p{N}#.-]+/gu)
    ?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [];
}

function tokenMatches(queryToken: string, documentToken: string) {
  if (queryToken === documentToken) return true;
  return queryToken.length >= 5 && documentToken.length >= 5 &&
    (queryToken.startsWith(documentToken) || documentToken.startsWith(queryToken));
}

export function relevanceScore(
  query: string,
  match: IndexedChunk & { score: number },
  ignoredTokens = new Set<string>()
) {
  const allQueryTokens = [...new Set(tokenize(query))];
  const queryTokens = allQueryTokens.filter((token) => !ignoredTokens.has(token));
  if (queryTokens.length === 0) return round(clamp(match.score) * 0.7);

  const contentTokens = tokenize(`${match.metadata.title} ${match.metadata.section} ${match.content}`);
  const titleTokens = tokenize(`${match.metadata.title} ${match.metadata.section}`);
  const matched = queryTokens.filter((queryToken) => contentTokens.some((token) => tokenMatches(queryToken, token)));
  const titleMatched = queryTokens.filter((queryToken) => titleTokens.some((token) => tokenMatches(queryToken, token)));
  const lexicalCoverage = matched.length / queryTokens.length;
  const titleCoverage = titleMatched.length / queryTokens.length;
  const semanticScore = clamp(match.score);

  return round(clamp(semanticScore * 0.45 + lexicalCoverage * 0.45 + titleCoverage * 0.1));
}

function commonQueryTokens(index: DocumentIndex, query: string, strategy: ChunkingStrategy) {
  const chunks = index.chunks.filter((chunk) => chunk.metadata.strategy === strategy);
  const sourceNames = [...new Set(chunks.map((chunk) => chunk.metadata.source))];
  if (sourceNames.length < 3) return new Set<string>();

  const tokensBySource = new Map(sourceNames.map((source) => [
    source,
    new Set(tokenize(chunks
      .filter((chunk) => chunk.metadata.source === source)
      .map((chunk) => `${chunk.metadata.title} ${chunk.content}`)
      .join(' ')))
  ]));

  return new Set([...new Set(tokenize(query))].filter((token) => {
    const documentFrequency = [...tokensBySource.values()].filter((tokens) => tokens.has(token)).length;
    return documentFrequency / sourceNames.length >= 0.75;
  }));
}

function averageRelevance(matches: RagMatch[]) {
  if (matches.length === 0) return 0;
  return round(matches.reduce((sum, match) => sum + match.relevanceScore, 0) / matches.length);
}

function resultSet(query: string, candidates: RagMatch[], selected: RagMatch[]): RagResultSet {
  return {
    query,
    candidatesCount: candidates.length,
    selected,
    averageRelevance: averageRelevance(selected)
  };
}

export function runRagRetrieval(params: {
  index: DocumentIndex;
  originalQuery: string;
  rewrittenQuery: string;
  strategy: ChunkingStrategy;
  mode: RagMode;
  config?: RagConfig;
  sourceNames?: string[];
}): RagRetrieval {
  const config = params.config ?? DEFAULT_RAG_CONFIG;
  const baselineIgnoredTokens = commonQueryTokens(params.index, params.originalQuery, params.strategy);
  const baselineCandidates = searchIndex(
    params.index,
    params.originalQuery,
    params.strategy,
    config.searchTopK,
    params.sourceNames
  ).map((match) => ({
    ...match,
    relevanceScore: relevanceScore(
      params.originalQuery,
      match,
      baselineIgnoredTokens
    )
  }));

  const expandedQuery = params.rewrittenQuery === params.originalQuery
    ? params.originalQuery
    : `${params.originalQuery}\n${params.rewrittenQuery}`;
  const improvedIgnoredTokens = commonQueryTokens(params.index, expandedQuery, params.strategy);
  const improvedCandidates = searchIndex(
    params.index,
    expandedQuery,
    params.strategy,
    config.searchTopK,
    params.sourceNames
  )
    .map((match) => ({
      ...match,
      relevanceScore: relevanceScore(
        expandedQuery,
        match,
        improvedIgnoredTokens
      )
    }))
    .sort((left, right) => right.relevanceScore - left.relevanceScore || right.score - left.score);

  const baseline = resultSet(params.originalQuery, baselineCandidates, baselineCandidates);
  const improvedSelected = improvedCandidates
    .filter((match) => match.relevanceScore >= config.relevanceThreshold)
    .slice(0, config.filteredTopK);
  const improved = resultSet(params.rewrittenQuery, improvedCandidates, improvedSelected);

  return {
    mode: params.mode,
    originalQuery: params.originalQuery,
    rewrittenQuery: params.rewrittenQuery,
    config,
    baseline,
    improved,
    active: params.mode === 'baseline' ? baseline : improved
  };
}

export function publicRagDiagnostics(retrieval: RagRetrieval) {
  const serializeSet = (set: RagResultSet) => ({
    query: set.query,
    candidatesCount: set.candidatesCount,
    selectedCount: set.selected.length,
    averageRelevance: set.averageRelevance,
    sources: set.selected.map((match) => ({
      source: match.metadata.source,
      title: match.metadata.title,
      section: match.metadata.section,
      vectorScore: round(match.score),
      relevanceScore: match.relevanceScore
    }))
  });

  return {
    mode: retrieval.mode,
    originalQuery: retrieval.originalQuery,
    rewrittenQuery: retrieval.rewrittenQuery,
    config: retrieval.config,
    baseline: serializeSet(retrieval.baseline),
    improved: serializeSet(retrieval.improved),
    active: retrieval.mode === 'baseline' ? 'baseline' : 'improved'
  };
}

import type { DiagnosticLog } from './logs.js';

const endpoint = 'https://api.tavily.com/search';
const maxResults = 2;
const maxQueryLength = 500;
const maxResponseBytes = 256 * 1024;

export interface WebSearchResult {
  id: string;
  title: string;
  url: string;
  content: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
}

type Fetch = typeof fetch;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export class TavilySearch {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly logs?: DiagnosticLog,
    private readonly request: Fetch = fetch,
  ) {}

  async search(query: string, signal: AbortSignal): Promise<WebSearchResponse> {
    const normalized = query.trim();
    if (!normalized || normalized.length > maxQueryLength)
      throw new Error('La recherche doit contenir de 1 à 500 caractères.');
    const apiKey = this.apiKey();
    if (!apiKey)
      throw new Error('Clé Tavily absente. Ajoutez-la dans Mise en route → Clés et jetons.');

    const response = await this.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: normalized,
        search_depth: 'basic',
        topic: 'general',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes)
      throw new Error('Réponse du service de recherche trop volumineuse.');
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error('Réponse JSON invalide du service de recherche.', { cause: error });
    }
    if (!response.ok) {
      const record = object(payload);
      const message =
        typeof record.message === 'string'
          ? record.message.slice(0, 300)
          : `Le service de recherche a répondu HTTP ${response.status}.`;
      this.logs?.write('warn', 'recherche', 'Recherche web refusée par Tavily', {
        status: response.status,
        code: record.code,
      });
      throw new Error(message);
    }

    const rows = object(payload).results;
    if (!Array.isArray(rows)) throw new Error('Réponse de recherche sans liste de résultats.');
    const results: WebSearchResult[] = [];
    for (const row of rows) {
      const item = object(row);
      const url = safeUrl(item.url);
      if (!url || typeof item.content !== 'string') continue;
      const title = typeof item.title === 'string' ? item.title.trim().slice(0, 80) : '';
      const content = item.content.trim().slice(0, 1200);
      if (!content) continue;
      results.push({
        id: String(results.length + 1),
        title: title || new URL(url).hostname,
        url,
        content,
      });
      if (results.length === maxResults) break;
    }

    this.logs?.write('info', 'recherche', 'Recherche web terminée', {
      resultCount: results.length,
    });
    return { results };
  }
}

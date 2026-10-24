import assert from 'node:assert/strict';
import test from 'node:test';
import { TavilySearch } from '../server/tavily-search.js';

test('Tavily envoie une recherche basic et ne conserve que des sources HTTP(S)', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const search = new TavilySearch(
    () => 'test-key',
    undefined,
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Source sûre',
              url: 'https://example.org/article',
              content: 'Information vérifiable.',
            },
            {
              title: 'URL invalide',
              url: 'javascript:alert(1)',
              content: 'À ignorer.',
            },
            {
              title: 'Sans contenu',
              url: 'https://example.org/empty',
              content: ' ',
            },
            {
              title: 'Résultat supplémentaire',
              url: 'https://example.org/extra',
              content: 'Ne doit pas dépasser la limite.',
            },
          ],
        }),
        { status: 200 },
      );
    },
  );

  const result = await search.search('  actualité récente  ', new AbortController().signal);

  assert.deepEqual(requestBody, {
    api_key: 'test-key',
    query: 'actualité récente',
    search_depth: 'basic',
    topic: 'general',
    max_results: 2,
    include_answer: false,
    include_raw_content: false,
  });
  assert.deepEqual(result.results, [
    {
      id: '1',
      title: 'Source sûre',
      url: 'https://example.org/article',
      content: 'Information vérifiable.',
    },
    {
      id: '2',
      title: 'Résultat supplémentaire',
      url: 'https://example.org/extra',
      content: 'Ne doit pas dépasser la limite.',
    },
  ]);
});

test('Tavily échoue clairement sans clé et sur une réponse HTTP en erreur', async () => {
  let requested = false;
  const missingKey = new TavilySearch(
    () => undefined,
    undefined,
    async () => {
      requested = true;
      return new Response();
    },
  );
  await assert.rejects(
    missingKey.search('question', new AbortController().signal),
    /Clé Tavily absente/u,
  );
  assert.equal(requested, false);

  const rejected = new TavilySearch(
    () => 'test-key',
    undefined,
    async () => new Response(JSON.stringify({ message: 'Quota épuisé.' }), { status: 429 }),
  );
  await assert.rejects(rejected.search('question', new AbortController().signal), /Quota épuisé/u);
});

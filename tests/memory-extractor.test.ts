import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiMemoryExtractor, createMemoryExtractor } from '../server/memory-extractor.js';

test('Responses extrait sans stockage distant ni outils, avec schéma strict et modèle configuré', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const extract = createMemoryExtractor('test-key-not-real', async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      id: 'response-fixture',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: '{"schemaVersion":1,"changes":[]}', annotations: [] },
          ],
        },
      ],
    });
  });
  const result = await extract(
    { now: new Date().toISOString(), turns: [], memories: [] },
    new AbortController().signal,
  );
  assert.deepEqual(result, { schemaVersion: 1, changes: [] });
  assert.equal(requestBody!.model, 'gpt-5.6-luna');
  assert.equal(requestBody!.store, false);
  assert.equal(requestBody!.tools, undefined);
  assert.deepEqual(requestBody!.reasoning, { effort: 'none' });
  const text = requestBody!.text as {
    format: { strict: boolean; schema: { additionalProperties: boolean } };
  };
  assert.equal(text.format.strict, true);
  assert.equal(text.format.schema.additionalProperties, false);
});
test('une réponse incomplète, un refus et une erreur fournisseur ne deviennent pas des propositions', async () => {
  for (const body of [
    { status: 'incomplete', output: [] },
    {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'refused' }] }],
    },
  ]) {
    const extract = createMemoryExtractor('test-key-not-real', async () =>
      Response.json({ ...body, object: 'response' }),
    );
    await assert.rejects(
      extract(
        { now: new Date().toISOString(), turns: [], memories: [] },
        new AbortController().signal,
      ),
      /incomplète/,
    );
  }
  let calls = 0;
  const extract = createMemoryExtractor('test-key-not-real', async () => {
    calls++;
    return Response.json({ error: { message: 'Fixture error' } }, { status: 500 });
  });
  await assert.rejects(
    extract(
      { now: new Date().toISOString(), turns: [], memories: [] },
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 1);
});

test('Gemini extrait la mémoire avec une clé en en-tête et une réponse JSON contrainte', async () => {
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const extract = createGeminiMemoryExtractor('test-gemini-key', async (url, init) => {
    requestUrl = String(url);
    requestHeaders = init?.headers;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      candidates: [
        {
          content: {
            parts: [{ text: '{"schemaVersion":1,"changes":[]}' }],
          },
        },
      ],
    });
  });
  const result = await extract(
    { now: new Date().toISOString(), turns: [], memories: [] },
    new AbortController().signal,
  );

  assert.deepEqual(result, { schemaVersion: 1, changes: [] });
  assert.equal(
    requestUrl,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  );
  assert.equal(new Headers(requestHeaders).get('x-goog-api-key'), 'test-gemini-key');
  assert.ok(!requestUrl.includes('test-gemini-key'));
  const generation = requestBody!.generationConfig as Record<string, unknown>;
  assert.equal(generation.responseMimeType, 'application/json');
  assert.equal(generation.maxOutputTokens, 6000);
  assert.ok(generation.responseSchema);
});

test('Gemini refuse les réponses sans texte valide', async () => {
  const extract = createGeminiMemoryExtractor('test-gemini-key', async () =>
    Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }),
  );
  await assert.rejects(
    extract(
      { now: new Date().toISOString(), turns: [], memories: [] },
      new AbortController().signal,
    ),
    /incomplète/u,
  );
});

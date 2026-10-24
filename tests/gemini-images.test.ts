import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { createGeminiImageCreator, type GeminiImageRequest } from '../server/gemini-images.js';
import { ImageGeneration } from '../server/image-generation.js';
import { openDatabase } from '../server/storage.js';
import { validators } from '../shared/validation.js';

const scope = { interactionId: 'interaction', profileEpoch: 1, contextVersion: 2 };

function png(): Buffer {
  const image = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(1024, 16);
  image.writeUInt32BE(1024, 20);
  return image;
}

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-gemini-images-'));
  const requests: GeminiImageRequest[] = [];
  const access = { blocked: false };
  let respond: (request: GeminiImageRequest) => Promise<Buffer> = async () => png();
  const generation = new ImageGeneration(db, true, () => {}, undefined, Date.now, directory);
  generation.useGemini({
    creator: () => (request) => {
      requests.push(request);
      return respond(request);
    },
    blocked: () => access.blocked,
  });
  t.after(() => {
    generation.dispose();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (prompt: string, signal = new AbortController().signal) =>
    generation.generate(scope, { prompt, seed: null }, signal);
  return {
    db,
    directory,
    generation,
    requests,
    access,
    create,
    respond: (next: typeof respond) => (respond = next),
  };
}

test('Gemini crée une image PNG carrée, conservée et réaffichable', async (t) => {
  const f = fixture(t);
  f.generation.setEnabled(true);
  f.generation.setProvider('gemini');
  f.generation.setGeminiModel('gemini-3-pro-image');

  const result = await f.create('  Un phare dans la brume  ');
  assert.equal(result.tool.status, 'succeeded', result.tool.summary);
  assert.equal(result.card?.model, 'gemini-3-pro-image');
  assert.equal(result.card?.imageUrl.endsWith('.png'), true);
  assert.equal(result.card?.width, 1024);
  assert.ok(validators.imageCard(result.card), JSON.stringify(validators.imageCard.errors));
  assert.equal(f.requests[0]?.prompt, 'Un phare dans la brume');
  assert.equal(f.requests[0]?.model, 'gemini-3-pro-image');
  assert.deepEqual(readFileSync(f.generation.generatedFile(result.tool.snapshotId!)!), png());
  assert.equal(
    f.generation.recall({ position: 1, search: null }, null).card?.imageUrl,
    result.card?.imageUrl,
  );

  const saved = f.db
    .prepare('SELECT gemini_model FROM image_generation_provider WHERE id = 1')
    .get();
  assert.equal(saved?.gemini_model, 'gemini-3-pro-image');
});

test('sans clé Gemini, les demandes échouent clairement et les illustrations ne partent pas', async (t) => {
  const f = fixture(t);
  f.generation.useGemini({ creator: () => null, blocked: () => false });
  f.generation.setEnabled(true);
  f.generation.setProvider('gemini');
  f.generation.setIllustrateCards(true);

  assert.match(f.generation.snapshot().geminiUnavailable ?? '', /Clé Gemini absente/);
  assert.equal(f.generation.canIllustrateCards(), false);
  assert.match((await f.create('Un chat')).tool.summary, /Clé Gemini absente/);
  assert.equal(f.requests.length, 0);
});

test('Gemini respecte le blocage global des connexions IA', async (t) => {
  const f = fixture(t);
  f.generation.setEnabled(true);
  f.generation.setProvider('gemini');
  f.access.blocked = true;
  assert.match(f.generation.snapshot().geminiUnavailable ?? '', /bloquées dans l’administration/);
  assert.match((await f.create('Un chat')).tool.summary, /bloquées dans l’administration/);
  assert.equal(f.requests.length, 0);
});

test('un quota Gemini refusé par Google remonte à l’outil vocal sans autre fournisseur', async (t) => {
  const f = fixture(t);
  f.generation.setEnabled(true);
  f.generation.setProvider('gemini');
  f.respond(async () => {
    throw new Error('Quota Gemini atteint : vérifiez les quotas et la facturation.');
  });

  const result = await f.create('Une affiche de montagne');
  assert.equal(result.tool.status, 'failed');
  assert.match(result.tool.summary, /Quota Gemini atteint/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.generation.snapshot().storedImages, 0);
});

test('la requête Gemini utilise le modèle autorisé, la clé en en-tête et un format carré', async () => {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: 'image/png', data: png().toString('base64') } }],
            },
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const image = await createGeminiImageCreator(
    'AIza-test-gemini-key',
    fetch,
  )({
    prompt: 'Une forêt',
    model: 'gemini-nano-banana-2.1',
    signal: new AbortController().signal,
  });

  assert.deepEqual(image, png());
  assert.equal(
    calls[0]?.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent',
  );
  assert.equal(calls[0]?.headers.get('x-goog-api-key'), 'AIza-test-gemini-key');
  assert.doesNotMatch(calls[0]!.url, /AIza-test-gemini-key/u);
  assert.deepEqual(calls[0]?.body, {
    contents: [{ parts: [{ text: 'Une forêt' }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    },
  });
});

test('les refus Gemini distinguent clé, modèle ou facturation, quota et filtre de sécurité', async () => {
  const messages: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const response = new Headers(init?.headers).get('x-goog-api-key');
    assert.equal(response, 'key-not-in-url');
    const next = messages.shift()!;
    const [status, message] = next.split(':', 2);
    return new Response(JSON.stringify({ error: { message } }), { status: Number(status) });
  };
  const creator = createGeminiImageCreator('key-not-in-url', fetch);
  const request: GeminiImageRequest = {
    prompt: 'Une image',
    model: 'gemini-3.1-flash-image',
    signal: new AbortController().signal,
  };
  for (const [status, body, expected] of [
    [401, 'bad key', /Clé Gemini refusée/],
    [403, 'billing disabled', /accès et sa facturation/],
    [429, 'quota exceeded', /Quota Gemini atteint/],
    [400, 'blocked by safety filter', /filtre de sécurité/],
  ] as const) {
    messages.push(`${status}:${body}`);
    await assert.rejects(creator(request), expected);
  }
});

test('Gemini rejette les réponses non-PNG ou dont l’image dépasse la taille attendue', async () => {
  for (const [mimeType, data] of [
    ['image/jpeg', png().toString('base64')],
    ['image/png', Buffer.alloc(24).toString('base64')],
    ['image/png', Buffer.alloc(24).toString('base64').slice(0, 10)],
  ]) {
    const creator = createGeminiImageCreator(
      'key',
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }],
          }),
        ),
    );
    await assert.rejects(
      creator({
        prompt: 'Une image',
        model: 'gemini-3.1-flash-image',
        signal: new AbortController().signal,
      }),
    );
  }
});

test('l’administration sélectionne Gemini et garde sa clé côté serveur', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-gemini-images-app-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keys: string[] = [];
  const services = await createApp(
    {
      databasePath: ':memory:',
      perceptionToken: 'p'.repeat(40),
      imageGenerationToken: 'i'.repeat(40),
      adminPassword: 'mot-de-passe-gemini',
      origins: ['http://localhost'],
      secureCookies: false,
      geminiKey: 'AIza-test-gemini-secret',
    },
    {
      timers: false,
      imageGenerationRoot: directory,
      geminiImageCreator: (key) => {
        keys.push(key);
        return async () => png();
      },
    },
  );
  await services.app.ready();
  t.after(() => services.app.close());
  const login = await services.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin: 'http://localhost' },
    payload: { password: 'mot-de-passe-gemini' },
  });
  const cookie = login.cookies.find((entry) => entry.name === 'cornelius_admin')!;
  const headers = { origin: 'http://localhost', cookie: `${cookie.name}=${cookie.value}` };
  const patch = (payload: Record<string, unknown>) =>
    services.app.inject({ method: 'PATCH', url: '/api/admin/image-generation', headers, payload });

  assert.equal((await patch({ provider: 'gemini' })).statusCode, 200);
  assert.equal((await patch({ geminiModel: 'unrecognized-model' })).statusCode, 400);
  const saved = await patch({
    provider: 'gemini',
    geminiModel: 'gemini-3-pro-image',
    enabled: true,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().provider, 'gemini');
  assert.equal(saved.json().geminiModel, 'gemini-3-pro-image');
  assert.equal(saved.json().geminiUnavailable, null);
  assert.deepEqual(keys, ['AIza-test-gemini-secret']);
  assert.doesNotMatch(saved.body, /AIza-test-gemini-secret/u);
});

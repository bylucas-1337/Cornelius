import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import type { AppConfig } from '../server/config.js';
import { secretValueError } from '../server/secrets.js';

const origin = 'http://localhost';
const password = 'mot-de-passe-cles';
const openaiKey = 'sk-test-admin-0123456789abcd';

async function fixture(t: TestContext, overrides: Partial<AppConfig> = {}) {
  const imageRoot = mkdtempSync(join(tmpdir(), 'cornelius-secrets-images-'));
  const services = await createApp(
    {
      databasePath: ':memory:',
      perceptionToken: 'p'.repeat(40),
      imageGenerationToken: 'i'.repeat(40),
      adminPassword: password,
      origins: [origin],
      secureCookies: false,
      ...overrides,
    } satisfies AppConfig,
    { timers: false, imageGenerationRoot: imageRoot },
  );
  await services.app.ready();
  t.after(async () => {
    await services.app.close();
    rmSync(imageRoot, { recursive: true, force: true });
  });
  const login = await services.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { password },
  });
  const entry = login.cookies.find((cookie) => cookie.name === 'cornelius_admin')!;
  const headers = { origin, cookie: `${entry.name}=${entry.value}` };
  return { ...services, headers };
}

test('valeurs de clé acceptées', () => {
  assert.equal(secretValueError(openaiKey), null);
  assert.ok(secretValueError('court'));
  assert.ok(secretValueError('avec un espace dedans'));
  assert.ok(secretValueError('x'.repeat(600)));
  assert.ok(secretValueError(42));
});

test('la clé OpenAI se saisit dans l’administration et compte sans redémarrage', async (t) => {
  const f = await fixture(t);
  const list = await f.app.inject({ url: '/api/admin/secrets', headers: f.headers });
  assert.equal(list.statusCode, 200);
  const before = list.json().secrets;
  const geminiBefore = before.find((secret: { env: string }) => secret.env === 'GEMINI_API_KEY');
  const openaiBefore = before.find((secret: { env: string }) => secret.env === 'OPENAI_API_KEY');
  assert.equal(geminiBefore?.configured, false);
  assert.equal(openaiBefore?.configured, false);
  assert.equal(f.controller.snapshot().state.setup?.openaiKey, false);

  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/admin/secrets/OPENAI_API_KEY',
    headers: f.headers,
    payload: { value: `  ${openaiKey}  ` },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const openai = saved
    .json()
    .secrets.find((secret: { env: string }) => secret.env === 'OPENAI_API_KEY');
  assert.ok(openai);
  assert.deepEqual(
    { configured: openai.configured, source: openai.source, hint: openai.hint },
    { configured: true, source: 'admin', hint: 'abcd' },
  );
  // Jamais la valeur elle-même, ni dans la liste ni dans l’état diffusé.
  assert.ok(!saved.body.includes(openaiKey));
  assert.equal(f.controller.snapshot().state.setup?.openaiKey, true);
  const devices = await f.app.inject({ url: '/api/admin/devices', headers: f.headers });
  assert.equal(devices.json().apiConfigured, true);
  const logs = await f.app.inject({ url: '/api/admin/logs', headers: f.headers });
  assert.ok(!logs.body.includes(openaiKey));

  const removed = await f.app.inject({
    method: 'DELETE',
    url: '/api/admin/secrets/OPENAI_API_KEY',
    headers: f.headers,
  });
  assert.equal(
    removed.json().secrets.find((secret: { env: string }) => secret.env === 'OPENAI_API_KEY')
      .configured,
    false,
  );
  assert.equal(f.controller.snapshot().state.setup?.openaiKey, false);
});

test('une clé de .env reste la valeur de secours, une clé saisie passe avant', async (t) => {
  const f = await fixture(t, { openaiKey: 'sk-from-env-file-wxyz' });
  const list = (await f.app.inject({ url: '/api/admin/secrets', headers: f.headers })).json();
  const openaiSecret = list.secrets.find(
    (secret: { env: string }) => secret.env === 'OPENAI_API_KEY',
  );
  assert.equal(openaiSecret.source, 'env');
  assert.equal(openaiSecret.hint, 'wxyz');
  await f.app.inject({
    method: 'PUT',
    url: '/api/admin/secrets/OPENAI_API_KEY',
    headers: f.headers,
    payload: { value: openaiKey },
  });
  const removed = await f.app.inject({
    method: 'DELETE',
    url: '/api/admin/secrets/OPENAI_API_KEY',
    headers: f.headers,
  });
  assert.equal(
    removed.json().secrets.find((secret: { env: string }) => secret.env === 'OPENAI_API_KEY')
      .source,
    'env',
  );
});

test('Gemini est le fournisseur de conversation prioritaire et se configure sans OpenAI', async (t) => {
  const f = await fixture(t);
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/admin/secrets/GEMINI_API_KEY',
    headers: f.headers,
    payload: { value: 'gemini-test-key-0123456789' },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const gemini = saved
    .json()
    .secrets.find((secret: { env: string }) => secret.env === 'GEMINI_API_KEY');
  assert.equal(gemini.configured, true);
  assert.ok(!saved.body.includes('gemini-test-key-0123456789'));
  assert.equal(f.controller.snapshot().state.setup?.openaiKey, true);
  const devices = await f.app.inject({ url: '/api/admin/devices', headers: f.headers });
  assert.equal(devices.json().apiConfigured, true);
});

test('la clé Tavily se configure dans l’administration sans divulguer sa valeur', async (t) => {
  const f = await fixture(t);
  const before = (await f.app.inject({ url: '/api/admin/secrets', headers: f.headers })).json();
  const tavilyBefore = before.secrets.find(
    (secret: { env: string }) => secret.env === 'TAVILY_API_KEY',
  );
  assert.ok(tavilyBefore);
  const fallback = { configured: tavilyBefore.configured, source: tavilyBefore.source };

  const value = 'tavily-test-key-0123456789';
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/admin/secrets/TAVILY_API_KEY',
    headers: f.headers,
    payload: { value },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.ok(!saved.body.includes(value));
  assert.deepEqual(
    saved.json().secrets.find((secret: { env: string }) => secret.env === 'TAVILY_API_KEY'),
    {
      env: 'TAVILY_API_KEY',
      configured: true,
      source: 'admin',
      hint: '6789',
      label: 'Clé Tavily pour la recherche web',
      usedBy: 'Recherche web avec Gemini si Tavily est activé',
      url: 'https://app.tavily.com/home',
      note: '1 000 crédits gratuits par mois',
    },
  );

  const removed = await f.app.inject({
    method: 'DELETE',
    url: '/api/admin/secrets/TAVILY_API_KEY',
    headers: f.headers,
  });
  const afterRemoval = removed
    .json()
    .secrets.find((secret: { env: string }) => secret.env === 'TAVILY_API_KEY');
  assert.deepEqual({ configured: afterRemoval.configured, source: afterRemoval.source }, fallback);
});

test('jetons des modules : saisis dans l’administration, lus par le module', async (t) => {
  const f = await fixture(t);
  const definitions = async () =>
    (await f.app.inject({ url: '/api/admin/addons', headers: f.headers })).json();
  const weatherSecret = (body: { definitions: unknown[] }) => {
    const list = body.definitions as { secrets: { env: string; configured: boolean }[] }[];
    return list
      .flatMap((definition) => definition.secrets)
      .find((secret) => secret.env === 'CORNELIUS_METEO_CONCEPT_TOKEN');
  };
  const before = weatherSecret(await definitions());
  if (!before) return t.skip('module Météo absent');
  assert.equal(before.configured, false);
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/admin/secrets/CORNELIUS_METEO_CONCEPT_TOKEN',
    headers: f.headers,
    payload: { value: 'meteo-token-0123456789' },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(weatherSecret(await definitions())?.configured, true);
});

test('clés : réservées à l’administration, noms inconnus et valeurs invalides refusés', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ url: '/api/admin/secrets' })).statusCode, 401);
  const unknown = await f.app.inject({
    method: 'PUT',
    url: '/api/admin/secrets/PATH',
    headers: f.headers,
    payload: { value: 'quelque-chose-de-long' },
  });
  assert.equal(unknown.statusCode, 404);
  const invalid = await f.app.inject({
    method: 'PUT',
    url: '/api/admin/secrets/OPENAI_API_KEY',
    headers: f.headers,
    payload: { value: 'sk' },
  });
  assert.equal(invalid.statusCode, 400);
});

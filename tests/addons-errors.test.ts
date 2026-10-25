import assert from 'node:assert/strict';
import test from 'node:test';
import { AddonRuntime } from '../server/addons/runtime.js';
import { loadAddons } from '../server/addons/registry.js';
import { AddonRepository, openDatabase } from '../server/storage.js';
import {
  describeError,
  ERROR_CODE_LABELS,
  errorCodeLabel,
  httpStatusLabel,
  moduleStatus,
  runStatusLabel,
  sourceStatusLine,
} from '../web/components/admin/format.js';
import type { AddonInstanceView } from '../web/components/admin/types.js';

// Modules livrés seulement : un dépôt cornelius-modules cloné à côté ne change pas ces tests.
const { addons } = await loadAddons({ externalRoot: null });

function runtime(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return new AddonRuntime({
    addons,
    instances: new AddonRepository(db),
    http: {
      fetch: () => Promise.reject(new Error('aucun réseau dans ce test')),
    },
  });
}

function errorsOf(result: ReturnType<AddonRuntime['validateConfig']>) {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors;
}

test('un réglage invalide renvoie une erreur en français par champ', (t) => {
  const r = runtime(t);
  const valid = { insee: '75056', lat: null, lon: null, days: 3 };
  assert.deepEqual(r.validateConfig('weather', valid), { ok: true });
  assert.deepEqual(errorsOf(r.validateConfig('weather', { ...valid, insee: '75' })), [
    { path: 'insee', message: 'Format invalide.' },
  ]);
  assert.deepEqual(errorsOf(r.validateConfig('weather', { ...valid, days: 9 })), [
    { path: 'days', message: 'Valeur trop grande : au plus 7.' },
  ]);
  assert.deepEqual(errorsOf(r.validateConfig('weather', { ...valid, days: null })), [
    { path: 'days', message: 'Champ obligatoire.' },
  ]);
  assert.deepEqual(errorsOf(r.validateConfig('weather', { ...valid, lat: 'nord' })), [
    { path: 'lat', message: 'Nombre attendu.' },
  ]);
  const { days: _days, ...withoutDays } = valid;
  assert.deepEqual(errorsOf(r.validateConfig('weather', withoutDays)), [
    { path: 'days', message: 'Champ obligatoire.' },
  ]);
  assert.deepEqual(errorsOf(r.validateConfig('weather', { ...valid, extra: 1 })), [
    { path: 'extra', message: 'Champ inconnu de ce module.' },
  ]);
  assert.deepEqual(
    errorsOf(r.validateConfig('clock', { timeZone: '', showDate: true })).sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    [
      { path: 'showSeconds', message: 'Champ obligatoire.' },
      { path: 'timeZone', message: 'Champ obligatoire.' },
    ],
  );
});

test('une alternative non remplie nomme les possibilités avec les libellés du schéma', (t) => {
  const r = runtime(t);
  const result = r.validateConfig('weather', { insee: null, lat: null, lon: null, days: 3 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.message, 'Réglage incomplet : vérifiez les champs signalés.');
  assert.deepEqual(result.errors, [
    {
      path: 'insee',
      message: 'Renseignez « Code INSEE », ou « Latitude » et « Longitude ».',
    },
  ]);
});

test('les codes d’erreur se lisent en mots simples, partout pareil', () => {
  assert.equal(errorCodeLabel('config_invalid'), 'Réglage incomplet');
  assert.equal(errorCodeLabel('auth'), 'Identifiants refusés');
  assert.equal(errorCodeLabel('upstream'), 'Le service ne répond pas');
  assert.equal(errorCodeLabel('unavailable'), 'Le service ne répond pas');
  assert.equal(errorCodeLabel('inconnu'), 'Erreur inattendue');
  assert.equal(errorCodeLabel(null), 'Erreur inattendue');
  for (const label of Object.values(ERROR_CODE_LABELS)) assert.doesNotMatch(label, /[—–]/u);
  assert.equal(httpStatusLabel(404), 'Adresse introuvable (404)');
  assert.equal(httpStatusLabel(401), 'Identifiants refusés (401)');
  assert.equal(httpStatusLabel(503), 'Le service ne répond pas (503)');
  assert.equal(
    describeError({ code: 'config_invalid', message: 'Jeton Météo Concept non configuré.' }),
    'Réglage incomplet : Jeton Météo Concept non configuré.',
  );
  assert.equal(
    describeError({ code: 'timeout', message: '' }),
    'Le service a mis trop de temps à répondre.',
  );
  // Une exécution injoignable a échoué : elle n’a pas été « refusée » par la destination.
  assert.equal(runStatusLabel('failed'), 'échouée');
});

function source(patch: Partial<AddonInstanceView>): AddonInstanceView {
  return {
    id: 'a',
    addonId: 'weather',
    profileId: null,
    ref: 'maison',
    label: 'Maison',
    enabled: true,
    displayEnabled: false,
    config: {},
    configVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    snapshot: null,
    error: null,
    ...patch,
  };
}

const failed = {
  snapshot: {
    snapshotId: 'weather:maison:error',
    status: 'error' as const,
    revision: 0,
    fetchedAt: null,
    validUntil: null,
    source: null,
    dataVersion: 1,
    data: null,
  },
  error: { code: 'auth', message: 'Jeton Météo Concept refusé.', retryable: false, at: 1 },
};

test('le badge d’un module dit honnêtement s’il est prêt ou à corriger', () => {
  assert.deepEqual(moduleStatus([]), { label: 'À configurer', variant: 'outline' });
  assert.deepEqual(moduleStatus([source({})], 1), {
    label: 'Jeton manquant',
    variant: 'destructive',
  });
  assert.deepEqual(moduleStatus([source({ enabled: false })]), {
    label: 'Désactivé',
    variant: 'outline',
  });
  // Bogue d’origine : une source en erreur affichait un « 1 active » vert.
  assert.deepEqual(moduleStatus([source(failed)]), {
    label: '1 source · à corriger',
    variant: 'destructive',
  });
  assert.deepEqual(moduleStatus([source({}), source({ id: 'b', ...failed })]), {
    label: '1 source · à corriger',
    variant: 'destructive',
  });
  assert.deepEqual(moduleStatus([source({})]), { label: 'Prêt', variant: 'secondary' });
});

test('une source sans relevé dit « Pas encore de données » et la raison traduite', () => {
  assert.equal(sourceStatusLine(source({}), null), 'Pas encore de données');
  const line = sourceStatusLine(source(failed), null);
  assert.equal(line, 'Pas encore de données · Identifiants refusés : Jeton Météo Concept refusé.');
  assert.doesNotMatch(line, /Erreur|jamais/u);
});

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  coreVersion,
  externalAddonsRoot,
  loadAddons,
  validateAddonDefinition,
} from '../server/addons/registry.js';

const clockDirectory = resolve(import.meta.dirname, '..', 'addons', 'clock');

/** Copie le module Heure sous un autre identifiant, comme le ferait un dépôt de modules. */
function copyClock(root: string, id: string, patch = (source: string) => source): void {
  const directory = join(root, id);
  cpSync(clockDirectory, directory, { recursive: true });
  const entry = join(directory, 'index.ts');
  writeFileSync(entry, patch(readFileSync(entry, 'utf8').replace("id: 'clock'", `id: '${id}'`)));
}

/**
 * Dépôt de modules cloné hors du cœur : son propre package.json masquerait les alias
 * `#cornelius/…` sans la résolution forcée du registre.
 */
function externalRepository(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'cornelius-modules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{ "name": "cornelius-modules", "type": "module" }');
  mkdirSync(join(root, 'docs'));
  return root;
}

test('un module externe se charge à côté des modules livrés, depuis un dépôt séparé', async (t) => {
  const root = externalRepository(t);
  copyClock(root, 'horloge');
  // Un dossier commençant par « _ » (le gabarit _template) se copie, il ne se charge pas.
  copyClock(root, '_template');
  const { addons, rejected } = await loadAddons({ externalRoot: root });
  const ids = addons.map((addon) => addon.id);
  assert.ok(ids.includes('horloge'));
  assert.ok(ids.includes('clock'));
  assert.equal(
    ids.some((id) => id.includes('template')),
    false,
  );
  assert.deepEqual(ids, [...ids].sort());
  // Les dossiers sans index.ts d'un dépôt externe (docs/…) ne sont pas des modules.
  assert.deepEqual(rejected, []);
});

test('un module ne prend pas le nom d’un outil du cœur (mail, image, http…)', async (t) => {
  const root = externalRepository(t);
  copyClock(root, 'mail');
  copyClock(root, 'image');
  const { addons, rejected } = await loadAddons({ externalRoot: root });
  assert.equal(
    addons.some((addon) => addon.id === 'mail' || addon.id === 'image'),
    false,
  );
  assert.deepEqual(
    rejected.map((item) => [item.name, item.reason]),
    [
      ['image', 'identifiant réservé à un outil de Cornelius.'],
      ['mail', 'identifiant réservé à un outil de Cornelius.'],
    ],
  );
});

test('un module externe ne remplace jamais un module livré', async (t) => {
  const root = externalRepository(t);
  copyClock(root, 'clock', (source) => source.replace("sourceLabel: '", "sourceLabel: 'Faux "));
  const { addons, rejected } = await loadAddons({ externalRoot: root });
  assert.equal(addons.filter((addon) => addon.id === 'clock').length, 1);
  assert.equal(addons.find((addon) => addon.id === 'clock')!.sourceLabel.startsWith('Faux'), false);
  assert.deepEqual(
    rejected.map((item) => item.name),
    ['clock'],
  );
});

test('un module externe trop récent pour le cœur est refusé avec la raison', async (t) => {
  const root = externalRepository(t);
  copyClock(root, 'futur', (source) =>
    source.replace('apiVersion: 1,', "apiVersion: 1,\n  minCoreVersion: '999.0.0',"),
  );
  const { addons, rejected } = await loadAddons({ externalRoot: root });
  assert.equal(
    addons.some((addon) => addon.id === 'futur'),
    false,
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason, /nécessite Cornelius 999\.0\.0/u);
});

test('la version minimale du cœur est facultative et comparée numériquement', async () => {
  const { addons } = await loadAddons({ externalRoot: null });
  const clock = addons.find((addon) => addon.id === 'clock')!;
  assert.match(coreVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(validateAddonDefinition({ ...clock, minCoreVersion: coreVersion }), null);
  assert.equal(validateAddonDefinition({ ...clock, minCoreVersion: '0.9.0' }, '0.10.0'), null);
  assert.notEqual(validateAddonDefinition({ ...clock, minCoreVersion: '0.10.0' }, '0.9.0'), null);
  for (const minCoreVersion of ['1', '1.2', 'v1.2.3', '01.2.3', 1])
    assert.notEqual(
      validateAddonDefinition({ ...clock, minCoreVersion }),
      null,
      String(minCoreVersion),
    );
});

test('le dossier externe vient de CORNELIUS_MODULES_DIR, sinon de ../cornelius-modules', () => {
  assert.equal(
    externalAddonsRoot({ CORNELIUS_MODULES_DIR: 'modules-maison' }),
    resolve('modules-maison'),
  );
  assert.equal(
    externalAddonsRoot({}),
    resolve(import.meta.dirname, '..', '..', 'cornelius-modules'),
  );
});

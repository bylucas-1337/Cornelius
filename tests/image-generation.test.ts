import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { WebSocket } from 'ws';
import { ImageGeneration } from '../server/image-generation.js';
import { openDatabase } from '../server/storage.js';
import type { ImageGenerationActivity } from '../shared/types.js';

class FakeWorker extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  output: string | null = null;
  /** false : la génération reste en cours jusqu’à `finish()`. */
  constructor(private readonly immediate = true) {
    super();
  }
  send(payload: string) {
    const event = JSON.parse(payload) as Record<string, unknown>;
    this.sent.push(event);
    if (event.type !== 'generate') return;
    this.output = String(event.output);
    if (this.immediate) queueMicrotask(() => this.finish(event));
  }
  finish(event = this.sent.filter((entry) => entry.type === 'generate').at(-1)!) {
    writeFileSync(String(event.output), Buffer.from('RIFF0000WEBPcornelius-test-image'));
    this.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'result', requestId: event.requestId })),
      false,
    );
  }
  of(type: string) {
    return this.sent.filter((event) => event.type === type);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

const scope = { interactionId: 'interaction', profileEpoch: 1, contextVersion: 2 };

function fixture(t: TestContext, immediate = true) {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-images-'));
  const worker = new FakeWorker(immediate);
  const activity: (ImageGenerationActivity | null)[] = [];
  const generation = new ImageGeneration(db, true, () => {}, undefined, Date.now, directory);
  generation.onActivity((value) => activity.push(value));
  generation.setEnabled(true);
  generation.connect(worker as unknown as WebSocket);
  t.after(() => {
    generation.dispose();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (prompt: string, profileId: string | null = null, automatic = false) =>
    generation.generate(
      scope,
      { prompt, seed: null },
      new AbortController().signal,
      automatic,
      profileId,
    );
  return { db, directory, worker, generation, activity, create };
}

test('le générateur local valide la demande, conserve le modèle et produit une carte image', async (t) => {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-images-'));
  const worker = new FakeWorker();
  const generation = new ImageGeneration(db, true, () => {}, undefined, Date.now, directory);
  t.after(() => {
    generation.dispose();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(generation.tools(), []);
  assert.equal(generation.snapshot().illustrateCards, false);
  generation.setIllustrateCards(true);
  assert.equal(generation.canIllustrateCards(), false);
  generation.setEnabled(true);
  generation.setModel('sana-sprint-0.6b');
  assert.equal(generation.snapshot().sanaSteps, 2);
  generation.setSanaSteps(4);
  generation.connect(worker as unknown as WebSocket);
  assert.equal(generation.snapshot().connected, true);
  assert.equal(generation.canIllustrateCards(), true);
  assert.deepEqual(
    generation.tools().map((tool) => tool.name),
    ['image__generate', 'image__recall'],
  );

  const result = await generation.generate(
    scope,
    { prompt: '  Un phare minimaliste dans la brume  ', seed: 42 },
    new AbortController().signal,
  );
  assert.equal(result.tool.status, 'succeeded');
  assert.equal(result.card?.cardType, 'image');
  assert.equal(result.card?.prompt, 'Un phare minimaliste dans la brume');
  assert.equal(result.card?.model, 'sana-sprint-0.6b');
  assert.equal(result.card?.width, 512);
  assert.equal(result.card?.height, 512);
  assert.match(result.card?.imageUrl ?? '', /^\/api\/generated-images\/[a-f0-9-]{36}\.webp$/u);
  assert.equal(generation.generatedFile(result.tool.snapshotId!), worker.output);

  const request = worker.of('generate')[0];
  assert.equal(request?.seed, 42);
  assert.equal(request?.model, 'sana-sprint-0.6b');
  assert.equal(request?.sanaSteps, 4);
  assert.equal(request?.prompt, 'Un phare minimaliste dans la brume');
  const reloaded = new ImageGeneration(db, true, () => {}, undefined, Date.now, directory);
  assert.equal(reloaded.snapshot().sanaSteps, 4);
  assert.equal(reloaded.snapshot().illustrateCards, true);
  // Le cache ne survit pas au redémarrage.
  assert.equal(existsSync(worker.output!), false);
  assert.equal(reloaded.generatedFile(result.tool.snapshotId!), null);
  reloaded.dispose();
});

test('le générateur refuse les paramètres invalides et un worker absent', async (t) => {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-images-'));
  const generation = new ImageGeneration(db, true, () => {}, undefined, Date.now, directory);
  t.after(() => {
    generation.dispose();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  generation.setEnabled(true);
  const invalid = await generation.generate(
    scope,
    { prompt: 'x', seed: null },
    new AbortController().signal,
  );
  assert.equal(invalid.tool.error?.code, 'invalid_params');
  const unavailable = await generation.generate(
    scope,
    { prompt: 'Une forêt sous la pluie', seed: null },
    new AbortController().signal,
  );
  assert.equal(unavailable.tool.error?.code, 'unavailable');
  assert.equal(unavailable.tool.error?.retryable, true);
});

test('le démarrage efface les images d’une exécution précédente', (t) => {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-images-'));
  const old = join(directory, '00000000-0000-4000-8000-000000000000.webp');
  const unrelated = join(directory, 'notes.txt');
  writeFileSync(old, 'RIFF');
  writeFileSync(unrelated, 'à garder');
  const generation = new ImageGeneration(db, true, () => {}, undefined, Date.now, directory);
  t.after(() => {
    generation.dispose();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(readdirSync(directory), ['notes.txt']);
});

test('une demande explicite coupe l’image en cours et prévient le worker ; une illustration attend', async (t) => {
  const f = fixture(t, false);
  const illustration = f.create('Une gare la nuit', null, true);
  assert.deepEqual(f.activity, [{ kind: 'illustration', startedAt: f.activity[0]!.startedAt }]);
  const busy = await f.create('Une autre illustration', null, true);
  assert.equal(busy.tool.error?.code, 'busy');
  const first = f.create('Un phare dans la brume');
  const replaced = await illustration;
  assert.equal(replaced.tool.status, 'failed');
  assert.match(replaced.tool.summary, /remplacée/);
  const firstRequest = f.worker.of('generate')[0]!;
  assert.deepEqual(f.worker.of('cancel'), [{ type: 'cancel', requestId: firstRequest.requestId }]);
  const second = f.create('Un chat roux');
  assert.equal((await first).tool.status, 'failed');
  assert.equal(f.worker.of('cancel').length, 2);
  f.worker.finish();
  const result = await second;
  assert.equal(result.tool.status, 'succeeded');
  assert.equal(result.card?.prompt, 'Un chat roux');
  assert.equal(f.activity.at(-1), null);
  assert.deepEqual(
    f.activity.filter(Boolean).map((entry) => entry!.kind),
    ['illustration', 'requested', 'requested'],
  );
});

test('trois images au plus : l’illustration part d’abord, puis la plus ancienne', async (t) => {
  const f = fixture(t);
  const phare = await f.create('Un phare dans la brume');
  const illustration = await f.create('Illustration de la météo', null, true);
  const chat = await f.create('Un chat roux');
  assert.equal(f.generation.snapshot().storedImages, 2);
  const forest = await f.create('Une forêt sous la pluie');
  const id = (result: typeof phare) => result.tool.snapshotId!;
  assert.equal(f.generation.generatedFile(id(illustration)), null);
  assert.ok(f.generation.generatedFile(id(phare)));
  const lake = await f.create('Un lac gelé');
  assert.equal(f.generation.generatedFile(id(phare)), null);
  assert.ok(f.generation.generatedFile(id(chat)));
  assert.ok(f.generation.generatedFile(id(forest)));
  assert.ok(f.generation.generatedFile(id(lake)));
  assert.equal(readdirSync(f.directory).filter((name) => name.endsWith('.webp')).length, 3);
});

test('une image gardée se réaffiche par position ou par sujet, sans franchir les profils', async (t) => {
  const f = fixture(t);
  const empty = f.generation.recall({ position: 1, search: null }, null);
  assert.equal(empty.tool.status, 'failed');
  assert.match(empty.tool.summary, /Aucune image récente/);
  await f.create('Un phare dans la brume');
  await f.create('Un chat roux sur un canapé', 'alice');
  await f.create('Une illustration de bus', null, true);
  const latest = f.generation.recall({ position: 1, search: null }, 'alice');
  assert.equal(latest.tool.status, 'succeeded');
  assert.equal(latest.card?.prompt, 'Un chat roux sur un canapé');
  assert.deepEqual(latest.tool.result?.position, 1);
  const found = f.generation.recall({ position: null, search: 'le PHARE' }, 'alice');
  assert.equal(found.card?.prompt, 'Un phare dans la brume');
  // L’image d’Alice reste privée ; celle du foyer est visible de tous.
  const bob = f.generation.recall({ position: null, search: 'chat' }, 'bob');
  assert.equal(bob.tool.status, 'failed');
  assert.match(bob.tool.summary, /phare/);
  assert.equal(f.generation.recall({ position: 2, search: null }, 'bob').tool.status, 'failed');
  assert.equal(
    f.generation.recall({ position: 4, search: null }, null).tool.error?.code,
    'invalid_params',
  );
});

test('pièce jointe d’un e-mail : l’image affichée d’abord, jamais celle d’un autre profil', async (t) => {
  const f = fixture(t);
  const none = f.generation.attachment(null, { shownId: null, position: null, search: null });
  assert.match('summary' in none ? none.summary : '', /Aucune image récente à envoyer/u);
  const phare = await f.create('Un phare dans la brume');
  const chat = await f.create('Un chat roux sur un canapé', 'alice');
  const bus = await f.create('Une illustration de bus', null, true);
  const id = (result: typeof phare) => result.tool.snapshotId!;
  const pick = (
    profileId: string | null,
    input: Partial<Parameters<typeof f.generation.attachment>[1]>,
  ) => {
    const found = f.generation.attachment(profileId, {
      shownId: null,
      position: null,
      search: null,
      ...input,
    });
    return 'image' in found ? found.image : null;
  };
  // L’illustration affichée se joint ; elle ne se retrouve pas par position.
  assert.equal(pick(null, { shownId: id(bus) })?.prompt, 'Une illustration de bus');
  assert.equal(pick('alice', {})?.prompt, 'Un chat roux sur un canapé');
  assert.equal(pick('alice', { position: 2 })?.prompt, 'Un phare dans la brume');
  assert.equal(pick('alice', { search: 'phare' })?.id, id(phare));
  // L’image d’Alice affichée devant Bob : la plus récente visible pour Bob part à la place.
  assert.equal(pick('bob', { shownId: id(chat) })?.id, id(phare));
  assert.equal(pick('bob', { search: 'chat' }), null);
  const path = pick(null, {})!.path;
  assert.equal(path, f.generation.generatedFile(id(phare)));
});

test('le préchargement demande au worker de charger le modèle et persiste', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.worker.of('configure').at(-1), {
    type: 'configure',
    model: f.generation.snapshot().model,
    preload: false,
  });
  f.generation.setPreload(true);
  assert.equal(f.worker.of('configure').at(-1)?.preload, true);
  f.generation.setModel('sdxl-turbo');
  assert.deepEqual(f.worker.of('configure').at(-1), {
    type: 'configure',
    model: 'sdxl-turbo',
    preload: true,
  });
  f.generation.setEnabled(false);
  assert.equal(f.worker.of('configure').at(-1)?.preload, false);
  const reloaded = new ImageGeneration(f.db, true, () => {}, undefined, Date.now, f.directory);
  assert.equal(reloaded.snapshot().preload, true);
  reloaded.dispose();
});

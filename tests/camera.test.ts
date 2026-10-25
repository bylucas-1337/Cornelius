import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CameraBridge } from '../server/camera.js';
import { openDatabase } from '../server/storage.js';

const status = {
  type: 'camera_status',
  selectedId: 'one',
  devices: [
    { id: 'one', label: 'Caméra 1' },
    { id: 'two', label: 'Caméra 2' },
  ],
  error: null,
};
function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const sent: { type: string; id?: string; requestId?: string }[] = [];
  let now = Date.now();
  const camera = new CameraBridge(
    db,
    () => {},
    () => now,
  );
  camera.connect((event) => sent.push(event as (typeof sent)[number]));
  camera.receive(status);
  t.after(() => {
    camera.disconnect();
    db.close();
  });
  return {
    db,
    camera,
    sent,
    advance: (ms: number) => {
      now += ms;
      camera.tick();
    },
  };
}
test('le choix est mémorisé seulement après confirmation puis restauré à la reconnexion', (t) => {
  const f = fixture(t);
  f.camera.select('two');
  assert.equal(f.db.prepare('SELECT device_id FROM camera_preferences').get()?.device_id, null);
  assert.equal(f.camera.snapshot().changing, true);
  const request = f.sent.at(-1)!;
  f.camera.receive({ ...status, selectedId: 'two', requestId: request.requestId });
  assert.equal(f.camera.snapshot().changing, false);
  assert.equal(f.db.prepare('SELECT device_id FROM camera_preferences').get()?.device_id, 'two');
  f.camera.connect((event) => f.sent.push(event as typeof request));
  f.camera.receive(status);
  assert.equal(f.sent.at(-1)?.type, 'camera_select');
  assert.equal(f.sent.at(-1)?.id, 'two');
});
test('une caméra refusée ou un accusé ancien ne remplace pas le choix enregistré', (t) => {
  const f = fixture(t);
  assert.throws(() => f.camera.select('absente'), /introuvable/);
  f.camera.select('two');
  f.camera.receive({ ...status, selectedId: 'two', requestId: 'ancien' });
  assert.equal(f.db.prepare('SELECT device_id FROM camera_preferences').get()?.device_id, null);
  f.camera.receive({ ...status, requestId: f.sent.at(-1)?.requestId, error: 'Caméra occupée.' });
  assert.equal(f.camera.snapshot().selectedId, 'one');
  assert.equal(f.camera.snapshot().error, 'Caméra occupée.');
  f.camera.select('two');
  f.advance(10_001);
  assert.equal(f.camera.snapshot().changing, false);
  assert.match(f.camera.snapshot().error!, /ne répond pas/);
});
test('l’aperçu est produit à la demande, partagé et les anciennes images sont ignorées', async (t) => {
  const f = fixture(t);
  assert.equal(f.sent.length, 0);
  const first = f.camera.preview();
  assert.equal(first, f.camera.preview());
  assert.equal(f.sent.length, 1);
  const id = f.sent.at(-1)!.requestId!;
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
  f.camera.image(Buffer.concat([Buffer.from('x'.repeat(36)), jpeg]));
  f.camera.image(Buffer.concat([Buffer.from(id), Buffer.from('pas une image')]));
  f.camera.image(Buffer.concat([Buffer.from(id), jpeg]));
  assert.deepEqual(await first, jpeg);
  const pending = f.camera.preview();
  const rejected = assert.rejects(pending, /déconnectée/);
  f.camera.disconnect();
  await rejected;
});

test('un envoi d’aperçu impossible rejette sa promesse et permet une nouvelle demande', async (t) => {
  const f = fixture(t);
  f.camera.connect(() => {
    throw new Error('Socket fermée');
  });
  f.camera.receive(status);
  await assert.rejects(f.camera.preview(), /déconnectée/);
  f.camera.connect((event) => f.sent.push(event as (typeof f.sent)[number]));
  f.camera.receive(status);
  const next = f.camera.preview();
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
  f.camera.image(Buffer.concat([Buffer.from(f.sent.at(-1)!.requestId!), jpeg]));
  assert.deepEqual(await next, jpeg);
});

test('résolution et cadence : enregistrées, envoyées à la perception et restaurées', (t) => {
  const { camera, sent, db } = fixture(t);
  const mode = { width: 640, height: 480, fps: 15 };
  camera.setMode(mode);
  const request = sent.at(-1) as { type: string; mode?: unknown; requestId?: string };
  assert.equal(request.type, 'camera_mode');
  assert.deepEqual(request.mode, mode);
  assert.equal(camera.snapshot().changing, true);
  camera.receive({
    ...status,
    requestId: request.requestId,
    mode,
    actual: { width: 640, height: 480, fps: 15 },
  });
  assert.equal(camera.snapshot().changing, false);
  assert.deepEqual(camera.snapshot().actual, { width: 640, height: 480, fps: 15 });

  // Une perception qui redémarre avec la valeur par défaut reçoit le réglage enregistré.
  const restored = new CameraBridge(db, () => {});
  const again: { type: string; mode?: unknown }[] = [];
  restored.connect((event) => again.push(event as (typeof again)[number]));
  restored.receive({ ...status, mode: { width: 1280, height: 720, fps: 30 }, actual: null });
  assert.deepEqual(again.find((event) => event.type === 'camera_mode')?.mode, mode);
  restored.disconnect();
});

test('caméra à l’envers : réglage enregistré et rendu à une perception qui redémarre', (t) => {
  const { camera, db } = fixture(t);
  const mode = { width: 1280, height: 720, fps: 30, rotate180: true };
  camera.setMode(mode);
  assert.deepEqual(camera.savedMode(), mode);
  const restored = new CameraBridge(db, () => {});
  const again: { type: string; mode?: unknown }[] = [];
  restored.connect((event) => again.push(event as (typeof again)[number]));
  restored.receive({ ...status, mode: { ...mode, rotate180: false }, actual: null });
  assert.deepEqual(again.find((event) => event.type === 'camera_mode')?.mode, mode);
  restored.disconnect();
});

test('browser resolution acknowledgements preserve the previously selected server camera', (t) => {
  const f = fixture(t);
  f.camera.select('two');
  f.camera.receive({ ...status, selectedId: 'two', requestId: f.sent.at(-1)!.requestId });
  f.camera.receive({
    type: 'camera_status',
    selectedId: 'browser',
    devices: [{ id: 'browser', label: 'Browser' }],
    error: null,
  });
  f.camera.setMode({ width: 640, height: 480, fps: 15 });
  f.camera.receive({
    type: 'camera_status',
    selectedId: 'browser',
    devices: [{ id: 'browser', label: 'Browser' }],
    error: null,
    requestId: f.sent.at(-1)!.requestId,
  });
  assert.equal(f.camera.savedDevice(), 'two');
});

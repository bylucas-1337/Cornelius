import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { WebSocket } from 'ws';
import { encodeBrowserCameraFrame } from '../shared/camera.js';
import { BrowserCameraRelay } from '../server/browser-camera.js';
class Socket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  code: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    this.code = code;
    this.readyState = 3;
    this.emit('close');
  }
}
const frame = (sequence: number) => {
  const bytes = Buffer.from([0x43, 0, 0, 0, 0, 255, 216, 1, 2, 255, 217]);
  bytes.writeUInt32BE(sequence, 1);
  return bytes;
};
test('browser camera bounds in-flight frames, validates binary JPEG and acknowledges only decoded sequence', () => {
  let time = 1;
  let allowed = true;
  let active = true;
  const frames: Buffer[] = [];
  let resets = 0;
  const relay = new BrowserCameraRelay(
    () => allowed,
    (f) => {
      frames.push(f);
      return true;
    },
    () => resets++,
    () => time,
  );
  const socket = new Socket();
  relay.connect(socket as unknown as WebSocket, () => active);
  socket.emit('message', frame(12), true);
  assert.equal(frames.length, 1);
  relay.acknowledge(11);
  assert.equal(socket.sent.length, 1);
  relay.acknowledge(12);
  assert.deepEqual(socket.sent.at(-1), { type: 'camera_ack', sequence: 12 });
  socket.emit('message', frame(13), true);
  socket.emit('message', frame(14), true);
  assert.equal(socket.code, 1008);
  assert.equal(resets, 1);
  const next = new Socket();
  relay.connect(next as unknown as WebSocket, () => active);
  active = false;
  next.emit('message', frame(15), true);
  assert.equal(next.code, 1008);
  const stale = new Socket();
  active = true;
  relay.connect(stale as unknown as WebSocket, () => active);
  time += 5001;
  relay.tick();
  assert.equal(stale.code, 1013);
  const revoked = new Socket();
  relay.connect(revoked as unknown as WebSocket, () => active);
  allowed = false;
  revoked.emit('message', frame(16), true);
  assert.equal(revoked.code, 1008);
});
test('browser camera rejects text, oversized and malformed images and resets a replaced connection', () => {
  for (const [value, binary] of [
    [frame(1), false],
    [Buffer.alloc(250006), true],
    [Buffer.from('not a jpeg'), true],
  ] as const) {
    const relay = new BrowserCameraRelay(
      () => true,
      () => assert.fail('must not forward'),
      () => {},
    );
    const socket = new Socket();
    relay.connect(socket as unknown as WebSocket, () => true);
    socket.emit('message', value, binary);
    assert.equal(socket.code, 1008);
  }
  let resets = 0;
  const relay = new BrowserCameraRelay(
    () => true,
    () => true,
    () => resets++,
  );
  const first = new Socket(),
    second = new Socket();
  relay.connect(first as unknown as WebSocket, () => true);
  relay.connect(second as unknown as WebSocket, () => true);
  first.emit('message', frame(1), true);
  assert.equal(resets, 1);
  assert.equal(second.sent.length, 1);
  relay.close();
});

test('JPEG transport never collides with reserved PCM packet lengths', () => {
  for (const length of [1019, 2557, 2000]) {
    const jpeg = new Uint8Array(length);
    jpeg.set([255, 216]);
    jpeg.set([255, 217], length - 2);
    const frame = encodeBrowserCameraFrame(jpeg.buffer, 0xffffffff);
    assert.equal(frame[0], 0x43);
    assert.equal(new DataView(frame.buffer).getUint32(1), 0xffffffff);
    assert.ok(![1024, 2562].includes(frame.length));
    assert.deepEqual([...frame.slice(5, 7)], [255, 216]);
    assert.deepEqual([...frame.slice(-2)], [255, 217]);
  }
});

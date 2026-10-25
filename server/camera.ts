import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CAMERA_MODE, isCameraMode, type CameraMode } from '../shared/camera.js';
import type { CameraStatus } from '../shared/types.js';
import { compile } from '../shared/validation.js';

const cameraId = { type: 'string', minLength: 1, maxLength: 1024 };
const validate = compile<{
  type: 'camera_status';
  selectedId: string | null;
  devices: CameraStatus['devices'];
  error: string | null;
  requestId?: string;
  mode?: CameraMode;
  actual?: { width: number; height: number; fps: number | null } | null;
}>({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'selectedId', 'devices', 'error'],
  properties: {
    type: { const: 'camera_status' },
    selectedId: { anyOf: [cameraId, { type: 'null' }] },
    requestId: { type: 'string', maxLength: 36 },
    error: { type: ['string', 'null'], maxLength: 240 },
    mode: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'fps'],
      properties: {
        width: { type: 'integer', minimum: 1, maximum: 8192 },
        height: { type: 'integer', minimum: 1, maximum: 8192 },
        fps: { type: 'integer', minimum: 1, maximum: 240 },
        rotate180: { type: 'boolean' },
      },
    },
    actual: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height', 'fps'],
          properties: {
            width: { type: 'integer', minimum: 1, maximum: 8192 },
            height: { type: 'integer', minimum: 1, maximum: 8192 },
            fps: { anyOf: [{ type: 'integer', minimum: 0, maximum: 1000 }, { type: 'null' }] },
          },
        },
      ],
    },
    devices: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label'],
        properties: { id: cameraId, label: { type: 'string', minLength: 1, maxLength: 120 } },
      },
    },
  },
});

export class CameraBridge {
  private sender: ((event: unknown) => void) | null = null;
  private state: CameraStatus = { selectedId: null, devices: [], changing: false, error: null };
  private selection: { id: string; requestId: string; expires: number } | null = null;
  private restored = false;
  private suspended = false;
  private frame: {
    id: string;
    promise: Promise<Buffer>;
    resolve(value: Buffer): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private db: DatabaseSync,
    private changed: () => void,
    private now = Date.now,
  ) {}
  snapshot(): CameraStatus {
    return { ...structuredClone(this.state), suspended: this.suspended };
  }
  isSuspended(): boolean {
    return this.suspended;
  }
  connect(send: (event: unknown) => void) {
    this.disconnect();
    this.sender = send;
    this.restored = false;
    this.suspended = false;
  }
  suspend() {
    this.suspended = true;
    this.restored = false;
    this.selection = null;
    this.state = { selectedId: null, devices: [], changing: false, error: null };
    this.cancelFrame('Caméra suspendue en mode voix.');
    this.changed();
  }
  resume() {
    this.suspended = false;
    this.restored = false;
  }
  disconnect() {
    this.sender = null;
    this.selection = null;
    this.state = { selectedId: null, devices: [], changing: false, error: null };
    this.cancelFrame('Caméra déconnectée.');
  }
  private send(event: unknown) {
    if (!this.sender) throw new Error('Démarrez la perception locale.');
    this.sender(event);
  }
  refresh() {
    if (this.suspended) return;
    this.send({ type: 'camera_list' });
  }
  select(id: string) {
    if (this.suspended) throw new Error('La caméra est suspendue en mode voix.');
    if (this.selection) throw new Error('Un changement de caméra est déjà en cours.');
    if (!this.state.devices.some((device) => device.id === id))
      throw new Error('Caméra introuvable.');
    this.cancelFrame('Changement de caméra.');
    const requestId = randomUUID();
    this.send({ type: 'camera_select', id, requestId });
    this.selection = { id, requestId, expires: this.now() + 10_000 };
    this.state.changing = true;
    this.state.error = null;
    this.changed();
  }
  /** Caméra choisie dans l’administration, transmise à l’allumage pour l’ouvrir directement. */
  savedDevice(): string | null {
    const saved = this.db
      .prepare('SELECT device_id FROM camera_preferences WHERE id = 1')
      .get()?.device_id;
    return typeof saved === 'string' ? saved : null;
  }
  /** Résolution et cadence enregistrées, sinon celles conseillées. */
  savedMode(): CameraMode {
    const raw = this.db.prepare('SELECT mode FROM camera_mode WHERE id = 1').get()?.mode;
    try {
      const mode = typeof raw === 'string' ? JSON.parse(raw) : null;
      return isCameraMode(mode) ? mode : { ...DEFAULT_CAMERA_MODE };
    } catch {
      return { ...DEFAULT_CAMERA_MODE };
    }
  }
  setMode(mode: CameraMode) {
    if (this.suspended) throw new Error('La caméra est suspendue en mode voix.');
    if (this.selection) throw new Error('Un changement de caméra est déjà en cours.');
    this.db.prepare('UPDATE camera_mode SET mode = ? WHERE id = 1').run(JSON.stringify(mode));
    this.cancelFrame('Changement de résolution.');
    this.state.mode = { ...mode };
    if (this.sender) {
      // La perception rouvre la caméra (sauf simple retournement) : même attente qu’un changement de périphérique.
      const requestId = randomUUID();
      this.send({ type: 'camera_mode', mode, requestId });
      if (this.state.selectedId)
        this.selection = { id: this.state.selectedId, requestId, expires: this.now() + 10_000 };
      this.state.changing = !!this.state.selectedId;
    }
    this.changed();
  }
  receive(event: unknown) {
    if (!validate(event) || this.suspended) return;
    this.state.devices = event.devices;
    this.state.selectedId = event.selectedId;
    this.state.error = event.error;
    if (event.mode) this.state.mode = event.mode;
    this.state.actual = event.actual ?? null;
    if (this.selection && event.requestId === this.selection.requestId) {
      if (!event.error && event.selectedId === this.selection.id && event.selectedId !== 'browser')
        this.db
          .prepare('UPDATE camera_preferences SET device_id = ? WHERE id = 1')
          .run(event.selectedId);
      this.selection = null;
      this.state.changing = false;
    }
    if (event.selectedId === 'browser') this.restored = true;
    if (!this.restored) {
      this.restored = true;
      // Résolution enregistrée envoyée à une perception qui démarre (ou ancienne : sans effet).
      const mode = this.savedMode();
      if (
        event.mode &&
        (event.mode.width !== mode.width ||
          event.mode.height !== mode.height ||
          event.mode.fps !== mode.fps ||
          !!event.mode.rotate180 !== !!mode.rotate180)
      )
        this.send({ type: 'camera_mode', mode });
      const saved = this.db
        .prepare('SELECT device_id FROM camera_preferences WHERE id = 1')
        .get()?.device_id;
      if (typeof saved === 'string' && saved !== event.selectedId) {
        if (event.devices.some((device) => device.id === saved)) this.select(saved);
        else
          this.state.error = 'La caméra mémorisée est absente. Choisissez une caméra disponible.';
      }
    }
    this.changed();
  }
  tick() {
    if (this.selection && this.now() >= this.selection.expires) {
      this.selection = null;
      this.state.changing = false;
      this.state.error = 'La caméra ne répond pas. Réessayez après vérification du périphérique.';
      this.changed();
    }
  }
  preview(): Promise<Buffer> {
    if (this.suspended || !this.sender || !this.state.selectedId || this.state.changing)
      return Promise.reject(new Error('Caméra indisponible.'));
    if (this.frame) return this.frame.promise;
    const id = randomUUID();
    let resolve!: (value: Buffer) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Buffer>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => this.cancelFrame('Aucune image récente reçue.'), 2000);
    this.frame = { id, promise, resolve, reject, timer };
    try {
      this.send({ type: 'camera_preview', requestId: id });
    } catch {
      this.cancelFrame('Caméra déconnectée.');
    }
    return promise;
  }
  image(data: Buffer) {
    const pending = this.frame;
    if (
      !pending ||
      data.length < 40 ||
      data.length > 256_000 ||
      data.subarray(0, 36).toString() !== pending.id
    )
      return;
    const jpeg = data.subarray(36);
    if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217) return;
    clearTimeout(pending.timer);
    this.frame = null;
    pending.resolve(jpeg);
  }
  private cancelFrame(message: string) {
    if (!this.frame) return;
    clearTimeout(this.frame.timer);
    this.frame.reject(new Error(message));
    this.frame = null;
  }
}

import type { WebSocket } from 'ws';
import { BROWSER_CAMERA_MAX_BYTES } from '../shared/camera.js';

/** Transport distinct de l’audio et des événements : jamais de file d’images à rattraper. */
export class BrowserCameraRelay {
  private socket: WebSocket | null = null;
  private pending: { sequence: number; at: number } | null = null;
  private lastFrameAt = 0;
  constructor(
    private allowed: () => boolean,
    private forward: (frame: Buffer) => boolean,
    private reset: () => void,
    private now = Date.now,
  ) {}
  connect(socket: WebSocket, active: () => boolean) {
    this.close();
    this.socket = socket;
    this.lastFrameAt = this.now();
    socket.on('message', (data, binary) => {
      if (this.socket !== socket) return;
      if (!active() || !this.allowed()) return this.close(1008);
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (
        !binary ||
        frame.length < 9 ||
        frame.length > BROWSER_CAMERA_MAX_BYTES + 5 ||
        frame[0] !== 0x43 ||
        frame[5] !== 255 ||
        frame[6] !== 216 ||
        frame.at(-2) !== 255 ||
        frame.at(-1) !== 217 ||
        this.pending
      ) {
        this.close(1008);
        return;
      }
      // La perception accuse réception après décodage, pas après l’envoi au réseau.
      this.pending = { sequence: frame.readUInt32BE(1), at: this.now() };
      this.lastFrameAt = this.now();
      if (!this.forward(frame)) this.close(1013);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.pending = null;
      this.reset();
    });
    socket.on('error', () => socket.close());
    socket.send(JSON.stringify({ type: 'camera_ready' }));
  }
  acknowledge(sequence: number) {
    if (this.pending?.sequence !== sequence || this.socket?.readyState !== 1) return;
    this.pending = null;
    this.socket.send(JSON.stringify({ type: 'camera_ack', sequence }));
  }
  tick() {
    if (this.socket && (!this.allowed() || this.now() - this.lastFrameAt > 5000)) this.close(1013);
  }
  close(code = 1000) {
    const socket = this.socket;
    this.socket = null;
    this.pending = null;
    socket?.close(code, 'Flux caméra interrompu.');
    if (socket) this.reset();
  }
}

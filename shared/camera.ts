export type CameraSource = 'server' | 'browser';
/** Images JPEG bornées ; une seule image en vol jusqu’à l’accusé de la perception. */
export const BROWSER_CAMERA_MAX_BYTES = 250_000;
export interface BrowserCameraConfig {
  schemaVersion: 1;
  type: 'camera_config';
  source: CameraSource;
  enabled: boolean;
  mode: CameraMode;
}

/** Résolution, cadence et orientation de la caméra, appliquées par la perception. */
export interface CameraMode {
  width: number;
  height: number;
  fps: number;
  /** Caméra montée tête en bas : l’image est retournée avant la détection. Absent : à l’endroit. */
  rotate180?: boolean;
}

export const CAMERA_RESOLUTIONS = [
  {
    width: 640,
    height: 480,
    label: '640 x 480',
    hint: 'La plus légère : pour un processeur modeste. Visages reconnus jusqu’à 1,5 m environ.',
  },
  {
    width: 1280,
    height: 720,
    label: '1280 x 720 (HD)',
    hint: 'Recommandée : visages reconnus plus loin et vision plus précise, pour un coût raisonnable.',
  },
  {
    width: 1920,
    height: 1080,
    label: '1920 x 1080 (Full HD)',
    hint: 'La plus détaillée, mais la détection des visages travaille plus : pour un processeur puissant.',
  },
] as const;

export const CAMERA_FRAME_RATES = [
  { fps: 15, label: '15 images par seconde', hint: 'Image plus lumineuse dans une pièce sombre.' },
  {
    fps: 30,
    label: '30 images par seconde',
    hint: 'Recommandée : image la plus récente et la plus nette en mouvement.',
  },
] as const;

export const DEFAULT_CAMERA_MODE: CameraMode = {
  width: 1280,
  height: 720,
  fps: 30,
  rotate180: false,
};

export function isCameraMode(value: unknown): value is CameraMode {
  if (!value || typeof value !== 'object') return false;
  const mode = value as Record<string, unknown>;
  return (
    CAMERA_RESOLUTIONS.some(
      (resolution) => resolution.width === mode.width && resolution.height === mode.height,
    ) &&
    CAMERA_FRAME_RATES.some((rate) => rate.fps === mode.fps) &&
    (mode.rotate180 === undefined || typeof mode.rotate180 === 'boolean')
  );
}

/** The worker reserves 1024 and 2562 byte packets for PCM audio. A JPEG comment
 * avoids ambiguous lengths without changing pixels or the existing audio protocol. */
export function encodeBrowserCameraFrame(
  image: ArrayBuffer,
  sequence: number,
): Uint8Array<ArrayBuffer> {
  const jpeg = new Uint8Array(image);
  const padding = [1024, 2562].includes(jpeg.byteLength + 5) ? 4 : 0;
  const frame = new Uint8Array(jpeg.byteLength + 5 + padding);
  frame[0] = 0x43;
  new DataView(frame.buffer).setUint32(1, sequence);
  if (padding) {
    frame.set(jpeg.subarray(0, 2), 5);
    frame.set([255, 254, 0, 2], 7);
    frame.set(jpeg.subarray(2), 11);
  } else frame.set(jpeg, 5);
  return frame;
}

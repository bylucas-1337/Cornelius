export interface AudioPreferences {
  microphone: string;
  speaker: string;
  /** Réduction du bruit du navigateur : GPT-Live filtre déjà le bruit ambiant. */
  noiseSuppression: boolean;
  /** Gain automatique : relève le micro dans les silences, et le haut-parleur avec lui. */
  autoGainControl: boolean;
}
const key = 'cornelius.audio';
const defaults: AudioPreferences = {
  microphone: '',
  speaker: '',
  noiseSuppression: true,
  autoGainControl: true,
};
export function audioPreferences(): AudioPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      microphone: typeof value.microphone === 'string' ? value.microphone : '',
      speaker: typeof value.speaker === 'string' ? value.speaker : '',
      noiseSuppression:
        typeof value.noiseSuppression === 'boolean'
          ? value.noiseSuppression
          : defaults.noiseSuppression,
      autoGainControl:
        typeof value.autoGainControl === 'boolean'
          ? value.autoGainControl
          : defaults.autoGainControl,
    };
  } catch {
    return { ...defaults };
  }
}
export function saveAudioPreferences(value: AudioPreferences) {
  localStorage.setItem(key, JSON.stringify(value));
}
/** Ce qui change la capture : un micro préparé avec d’autres réglages n’est pas réutilisé. */
export function captureKey(value: AudioPreferences = audioPreferences()): string {
  return [value.microphone, value.noiseSuppression, value.autoGainControl].join('|');
}

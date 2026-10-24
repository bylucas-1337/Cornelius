import type { GeminiImageModel } from '../shared/types.js';

export interface GeminiImageRequest {
  prompt: string;
  model: GeminiImageModel;
  signal: AbortSignal;
}

export type GeminiImageCreator = (request: GeminiImageRequest) => Promise<Buffer>;

const maxImageBytes = 20 * 1024 * 1024;
const maxResponseBytes = Math.ceil((maxImageBytes * 4) / 3) + 64 * 1024;
const maxErrorBytes = 64 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface GeminiPart {
  inlineData?: { mimeType?: unknown; data?: unknown };
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    await response.body?.cancel();
    throw new Error('Réponse Gemini trop volumineuse.');
  }
  if (!response.body) throw new Error('Réponse Gemini vide.');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('Réponse Gemini trop volumineuse.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function errorMessage(status: number, body: Buffer): string {
  let message = '';
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      error?: { message?: unknown };
    };
    if (typeof parsed.error?.message === 'string') message = parsed.error.message.slice(0, 1000);
  } catch {
    // Use the HTTP status when Google does not return a readable error body.
  }

  if (/safety|blocked|prohibited|recitation/iu.test(message))
    return 'Gemini a refusé cette description (filtre de sécurité).';
  if (status === 401) return 'Clé Gemini refusée : vérifiez-la dans Mise en route.';
  if (status === 403)
    return 'Gemini refuse ce modèle pour ce projet : vérifiez son accès et sa facturation Google.';
  if (status === 429)
    return 'Quota Gemini atteint : réessayez plus tard ou vérifiez les quotas et la facturation du projet Google.';
  if (status === 400)
    return 'Gemini a refusé cette demande ou ce modèle n’est pas disponible pour ce projet.';
  if (status === 404) return 'Ce modèle Gemini est inconnu ou n’est pas disponible pour ce projet.';
  if (status >= 500) return `Gemini est indisponible pour le moment (erreur ${status}).`;
  return `Gemini n’a pas pu créer l’image (erreur ${status}).`;
}

function pngImage(response: unknown): Buffer {
  if (typeof response !== 'object' || response === null)
    throw new Error('Gemini n’a renvoyé aucune image.');
  const generated = response as {
    candidates?: unknown;
    promptFeedback?: { blockReason?: unknown };
  };
  if (generated.promptFeedback?.blockReason)
    throw new Error('Gemini a refusé cette description (filtre de sécurité).');
  const candidates = generated.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0)
    throw new Error('Gemini n’a renvoyé aucune image utilisable.');
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const generatedCandidate = candidate as { content?: unknown; finishReason?: unknown };
    if (
      generatedCandidate.finishReason === 'SAFETY' ||
      generatedCandidate.finishReason === 'BLOCKLIST'
    )
      throw new Error('Gemini a refusé cette description (filtre de sécurité).');
    const content = generatedCandidate.content;
    if (typeof content !== 'object' || content === null) continue;
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts as GeminiPart[]) {
      const image = part?.inlineData;
      if (image?.mimeType !== 'image/png' || typeof image.data !== 'string') continue;
      const encoded = image.data;
      if (
        encoded.length === 0 ||
        encoded.length > Math.ceil(maxImageBytes / 3) * 4 ||
        encoded.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
      )
        throw new Error('Gemini a renvoyé une image invalide.');
      const buffer = Buffer.from(encoded, 'base64');
      if (
        buffer.length < 24 ||
        buffer.length > maxImageBytes ||
        buffer.toString('base64') !== encoded ||
        !buffer.subarray(0, pngSignature.length).equals(pngSignature) ||
        buffer.toString('ascii', 12, 16) !== 'IHDR' ||
        buffer.readUInt32BE(16) !== 1024 ||
        buffer.readUInt32BE(20) !== 1024
      )
        throw new Error('Gemini a renvoyé une image invalide (PNG carré 1024 × 1024 attendu).');
      return buffer;
    }
  }
  throw new Error('Gemini n’a renvoyé aucune image PNG utilisable.');
}

export function createGeminiImageCreator(
  apiKey: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): GeminiImageCreator {
  return async ({ prompt, model, signal }) => {
    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: { aspectRatio: '1:1' },
            },
          }),
          signal,
        },
      );
    } catch (error) {
      if (signal.aborted) throw new Error('Génération Gemini annulée.');
      throw new Error(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Gemini n’a pas répondu à temps pour créer l’image.'
          : 'Gemini est injoignable pour le moment.',
      );
    }

    if (!response.ok) {
      let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      try {
        body = await readBounded(response, maxErrorBytes);
      } catch {
        // The response body is either absent or was cancelled when it exceeded the limit.
      }
      throw new Error(errorMessage(response.status, body));
    }

    let body: Buffer;
    try {
      body = await readBounded(response, maxResponseBytes);
    } catch (error) {
      if (signal.aborted) throw new Error('Génération Gemini annulée.');
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new Error('Gemini a renvoyé une réponse illisible.');
    }
    return pngImage(parsed);
  };
}

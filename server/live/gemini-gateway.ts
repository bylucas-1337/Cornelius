import type { DiagnosticLog } from '../logs.js';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { MediaSessionConfig } from 'openai/resources/live/live';
import type { ConnectClientEvent, ConnectServerEvent } from 'openai/resources/live/sideband';
import type {
  LiveAudioConnection,
  LiveCreateResponse,
  LiveGateway,
  LiveHandlers,
} from './gateway.js';
import { sanitizeGeminiSchema } from '../gemini-schema.js';

const GEMINI_VOICES = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede']);

function mapVoice(voice?: string): string {
  if (!voice) return 'Puck';
  for (const v of GEMINI_VOICES) {
    if (v.toLowerCase() === voice.toLowerCase()) return v;
  }
  switch (voice.toLowerCase()) {
    case 'marin':
      return 'Aoede';
    case 'breeze':
      return 'Kore';
    case 'ember':
      return 'Fenrir';
    case 'cove':
      return 'Charon';
    default:
      return 'Puck';
  }
}

export function createGeminiLiveGateway(
  apiKey: string,
  logs?: DiagnosticLog,
  socketFactory: (url: string) => WebSocket = (url) =>
    new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 }),
): LiveGateway {
  const pendingSessions = new Map<
    string,
    { config: MediaSessionConfig; tavilySearchEnabled: boolean }
  >();
  let tavilySearchEnabled = true;

  function startSocket(
    config: MediaSessionConfig,
    handlers: LiveHandlers,
    remoteId?: string,
    useTavilySearch = tavilySearchEnabled,
  ): LiveAudioConnection {
    const id = remoteId ?? 'gemini_' + randomUUID();
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;

    logs?.write('info', 'gemini', 'Connexion de la session Live Gemini', { remoteId: id });

    const socket = socketFactory(url);

    let pendingToolCalls = 0;
    let setupDone = false;
    const toolCalls = new Map<string, string>();
    const maxErrorResponseBytes = 16 * 1024;

    function buildSetupPayload(cfg: MediaSessionConfig) {
      const delegationTools =
        ((
          (cfg.delegation as unknown as Record<string, unknown>)?.responses as Record<
            string,
            unknown
          >
        )?.tools as unknown[]) ?? [];
      const functionDeclarations: Array<{
        name: string;
        description: string;
        parameters?: Record<string, unknown>;
      }> = [];
      let useGoogleSearch = false;

      for (const tool of delegationTools) {
        const item = tool as Record<string, unknown>;
        if (item.type === 'web_search') {
          if (useTavilySearch) {
            functionDeclarations.push({
              name: 'web__search',
              description: 'Chercher des informations récentes sur le web et fournir des sources.',
              parameters: sanitizeGeminiSchema({
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', description: 'Question ou mots-clés à rechercher.' },
                },
              }),
            });
          } else {
            useGoogleSearch = true;
          }
        } else if (item.type === 'function' || item.name) {
          // Gemini ne supporte pas 'strict' ni les mots-clés JSON Schema non standard.
          const rawParams = item.parameters as Record<string, unknown> | undefined;
          const params = rawParams ? sanitizeGeminiSchema(rawParams) : undefined;
          functionDeclarations.push({
            name: String(item.name),
            description: String(item.description ?? ''),
            ...(params ? { parameters: params } : {}),
          });
        }
      }

      const toolsPayload: Array<Record<string, unknown>> = [];
      if (functionDeclarations.length > 0) {
        toolsPayload.push({ functionDeclarations });
      }
      if (useGoogleSearch) toolsPayload.push({ googleSearch: {} });

      const systemParts: Array<{ text: string }> = [];
      if (cfg.instructions) {
        systemParts.push({
          text: cfg.instructions.replaceAll(
            'web_search',
            useTavilySearch ? 'web__search' : 'la recherche Google native',
          ),
        });
      }
      const delegationInstructions = (
        (cfg.delegation as unknown as Record<string, unknown>)?.responses as Record<string, unknown>
      )?.instructions;
      if (typeof delegationInstructions === 'string' && delegationInstructions) {
        systemParts.push({
          text: delegationInstructions.replaceAll(
            'web_search',
            useTavilySearch ? 'web__search' : 'la recherche Google native',
          ),
        });
      }

      return {
        setup: {
          model: 'models/gemini-3.8-live',
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: mapVoice(
                    typeof cfg.audio?.output?.voice === 'string'
                      ? cfg.audio.output.voice
                      : undefined,
                  ),
                },
              },
            },
          },
          systemInstruction: {
            parts: systemParts,
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(toolsPayload.length > 0 ? { tools: toolsPayload } : {}),
        },
      };
    }

    socket.on('open', () => {
      logs?.write('info', 'gemini', 'WebSocket Gemini ouvert, envoi du setup', { remoteId: id });
      socket.send(JSON.stringify(buildSetupPayload(config)));
    });

    socket.on('unexpected-response', (_request, response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let storedBytes = 0;
      let truncated = false;

      response.on('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += data.length;
        const remaining = maxErrorResponseBytes - storedBytes;
        if (remaining > 0) {
          const stored = data.subarray(0, remaining);
          chunks.push(stored);
          storedBytes += stored.length;
        }
        if (data.length > remaining) truncated = true;
      });
      response.once('end', () => {
        logs?.write('error', 'gemini', 'Réponse HTTP de refus Gemini', {
          remoteId: id,
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: {
            contentType: response.headers['content-type'],
            requestId: response.headers['x-request-id'],
            googleRequestId: response.headers['x-goog-request-id'],
            retryAfter: response.headers['retry-after'],
          },
          body: Buffer.concat(chunks).toString('utf8'),
          bodyBytes: receivedBytes,
          bodyTruncated: truncated,
        });
        handlers.failure();
      });
      response.once('error', (error) => {
        logs?.write('error', 'gemini', 'Lecture de la réponse HTTP Gemini impossible', {
          remoteId: id,
          statusCode: response.statusCode,
          error,
        });
        handlers.failure();
      });
    });

    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;

        if (data.error && typeof data.error === 'object') {
          const error = data.error as Record<string, unknown>;
          const message =
            typeof error.message === 'string' ? error.message : 'Erreur renvoyée par Gemini.';
          logs?.write('error', 'gemini', message, {
            remoteId: id,
            code: error.code,
            status: error.status,
            providerError: error,
          });
          handlers.event({
            type: 'error',
            error: {
              type: 'server_error',
              code: String(error.status ?? error.code ?? 'gemini_error'),
              message,
            },
          } as unknown as ConnectServerEvent);
          return;
        }

        if (data.setupComplete) {
          setupDone = true;
          logs?.write('info', 'gemini', 'Setup Gemini validé', { remoteId: id });
          handlers.open();
          handlers.event({
            type: 'session.started',
            session: { id },
          } as ConnectServerEvent);
          return;
        }

        const toolCall =
          data.toolCall && typeof data.toolCall === 'object'
            ? (data.toolCall as Record<string, unknown>)
            : null;
        const functionCalls = Array.isArray(toolCall?.functionCalls)
          ? toolCall.functionCalls.filter(
              (item): item is Record<string, unknown> =>
                !!item &&
                typeof item === 'object' &&
                typeof (item as Record<string, unknown>).name === 'string' &&
                !!(item as Record<string, unknown>).name,
            )
          : [];
        if (functionCalls.length > 0) {
          pendingToolCalls += functionCalls.length;
          handlers.event({
            type: 'session.delegation.created',
            delegation: { id: 'gemini_delegation' },
          } as unknown as ConnectServerEvent);
          for (const item of functionCalls) {
            const call = item as { id?: unknown; name: string; args?: unknown };
            const callId =
              typeof call.id === 'string' && call.id ? call.id : call.name + '_' + randomUUID();
            toolCalls.set(callId, call.name);
            handlers.event({
              type: 'response.event',
              delegation_id: 'gemini_delegation',
              event: {
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  call_id: callId,
                  name: call.name,
                  arguments:
                    typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
                },
              },
            } as unknown as ConnectServerEvent);
          }
        }

        if (data.serverContent && typeof data.serverContent === 'object') {
          const content = data.serverContent as Record<string, unknown>;
          if (content.interrupted) {
            handlers.event({
              type: 'session.output_audio.interrupted',
            } as unknown as ConnectServerEvent);
          }
          const modelTurn = content.modelTurn as Record<string, unknown> | undefined;
          if (Array.isArray(modelTurn?.parts)) {
            for (const p of modelTurn.parts) {
              const part = p as Record<string, unknown>;
              const inlineData = part.inlineData as
                { data?: string; mimeType?: string } | undefined;
              if (
                inlineData?.data &&
                typeof inlineData.data === 'string' &&
                inlineData.mimeType?.startsWith('audio/')
              ) {
                handlers.event({
                  type: 'session.output_audio.delta',
                  delta: inlineData.data,
                } as unknown as ConnectServerEvent);
              }
              if (typeof part.text === 'string' && part.text) {
                handlers.event({
                  type: 'session.output_transcript.delta',
                  delta: part.text,
                } as unknown as ConnectServerEvent);
              }
            }
          }
          const inputTranscription = content.inputTranscription as
            Record<string, unknown> | undefined;
          if (typeof inputTranscription?.text === 'string' && inputTranscription.text) {
            handlers.event({
              type: 'session.input_transcript.delta',
              delta: inputTranscription.text,
            } as unknown as ConnectServerEvent);
          }
          const outputTranscription = content.outputTranscription as
            Record<string, unknown> | undefined;
          if (typeof outputTranscription?.text === 'string' && outputTranscription.text) {
            handlers.event({
              type: 'session.output_transcript.delta',
              delta: outputTranscription.text,
            } as unknown as ConnectServerEvent);
          }
          const grounding = (content.groundingMetadata ??
            (modelTurn as Record<string, unknown> | undefined)?.groundingMetadata) as
            Record<string, unknown> | undefined;
          const groundingChunks = Array.isArray(grounding?.groundingChunks)
            ? grounding.groundingChunks
            : [];
          const citations = groundingChunks.flatMap((chunk) => {
            const web = (chunk as Record<string, unknown> | null)?.web;
            if (!web || typeof web !== 'object') return [];
            const { uri, title } = web as Record<string, unknown>;
            return typeof uri === 'string'
              ? [{ type: 'url_citation', url: uri, title: typeof title === 'string' ? title : '' }]
              : [];
          });
          if (citations.length > 0) {
            handlers.event({
              type: 'response.event',
              delegation_id: 'gemini_delegation',
              event: {
                type: 'response.output_item.done',
                item: {
                  type: 'message',
                  content: [{ type: 'output_text', annotations: citations }],
                },
              },
            } as unknown as ConnectServerEvent);
          }
          if (content.turnComplete && pendingToolCalls === 0 && functionCalls.length === 0) {
            handlers.event({
              type: 'response.event',
              delegation_id: 'gemini_delegation',
              event: {
                type: 'response.completed',
                response: { id: 'gemini_resp_' + randomUUID() },
              },
            } as unknown as ConnectServerEvent);
          }
        }
      } catch (error) {
        logs?.write('error', 'gemini', 'Erreur de traitement message Gemini', {
          remoteId: id,
          error,
        });
        handlers.failure();
      }
    });

    socket.on('error', (error) => {
      logs?.write('error', 'gemini', 'Erreur WebSocket Gemini', { remoteId: id, error });
      handlers.failure();
    });

    socket.on('close', (code, reason) => {
      logs?.write('warn', 'gemini', 'WebSocket Gemini fermé', {
        remoteId: id,
        code,
        reason: reason?.toString(),
        reasonBytes: reason.byteLength,
        closeReasonLimitBytes: 123,
        reasonMayBeTruncated: reason.byteLength >= 123,
      });
      handlers.event({ type: 'session.closed' } as ConnectServerEvent);
      handlers.failure();
    });

    return {
      send(event: ConnectClientEvent) {
        if (socket.readyState !== WebSocket.OPEN) return;
        const ev = event as unknown as Record<string, unknown>;

        if (ev.type === 'response.item.create') {
          const item = ev.item as Record<string, unknown> | undefined;
          if (
            item?.type === 'function_call_output' &&
            typeof item.call_id === 'string' &&
            toolCalls.has(item.call_id)
          ) {
            let output: unknown;
            try {
              output = typeof item.output === 'string' ? JSON.parse(item.output) : item.output;
            } catch {
              output = { result: item.output };
            }
            const response =
              output && typeof output === 'object' && !Array.isArray(output)
                ? output
                : { result: output };
            const name = toolCalls.get(item.call_id)!;
            toolCalls.delete(item.call_id);
            pendingToolCalls = Math.max(0, pendingToolCalls - 1);
            socket.send(
              JSON.stringify({
                toolResponse: {
                  functionResponses: [
                    {
                      id: item.call_id,
                      name,
                      response,
                    },
                  ],
                },
              }),
            );
          }
        } else if (ev.type === 'response.create') {
          // Continuation après tool calls : Gemini reprend automatiquement après toolResponse,
          // mais on peut forcer une génération explicite si nécessaire.
          if (setupDone && pendingToolCalls === 0) {
            // Envoyer un clientContent vide pour forcer Gemini à continuer
            // (en pratique Gemini continue seul après toolResponse)
            logs?.write('info', 'gemini', 'Continuation demandée', { remoteId: id });
          }
        } else if (ev.type === 'session.update') {
          logs?.write('warn', 'gemini', 'Mise à jour des outils impossible pendant cette session', {
            remoteId: id,
          });
        } else if (
          ev.type === 'session.thinking.append' ||
          ev.type === 'session.commentary.append' ||
          ev.type === 'session.instructions.append'
        ) {
          // Contexte silencieux (vision caméra) ou commentaire oral
          const text = ev.content;
          if (typeof text === 'string' && text) {
            const isThinking =
              ev.type === 'session.thinking.append' || ev.type === 'session.instructions.append';
            socket.send(
              JSON.stringify({
                clientContent: {
                  turns: [
                    {
                      role: 'user',
                      parts: [
                        {
                          text:
                            ev.type === 'session.thinking.append'
                              ? `[Contexte caméra locale] ${text}`
                              : ev.type === 'session.instructions.append'
                                ? `[Consigne complémentaire] ${text}`
                                : text,
                        },
                      ],
                    },
                  ],
                  turnComplete: !isThinking,
                },
              }),
            );
            if (ev.type === 'session.thinking.append' && typeof ev.event_id === 'string') {
              queueMicrotask(() => {
                handlers.event({
                  type: 'session.thinking.appended',
                  client_event_id: ev.event_id as string,
                } as unknown as ConnectServerEvent);
              });
            }
          }
        } else if (ev.type === 'session.close') {
          socket.close(1000, 'Session closed normally');
        }
      },
      sendAudio(pcm: Buffer) {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: pcm.toString('base64'),
              },
            },
          }),
        );
      },
      dispose() {
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.terminate();
      },
    };
  }

  return {
    provider: 'gemini',
    setTavilySearchEnabled(enabled) {
      tavilySearchEnabled = enabled;
    },
    create: async (config) => {
      const id = 'gemini_' + randomUUID();
      pendingSessions.set(id, { config, tavilySearchEnabled });
      return {
        session: { id },
        transport: { type: 'websocket' },
      } satisfies LiveCreateResponse;
    },
    attach: (id, handlers) => {
      const pending = pendingSessions.get(id);
      pendingSessions.delete(id);
      if (!pending) throw new Error('Session Gemini introuvable.');
      return startSocket(pending.config, handlers, id, pending.tavilySearchEnabled);
    },
    connect: (session, handlers) => {
      return startSocket(
        session as unknown as MediaSessionConfig,
        handlers,
        undefined,
        tavilySearchEnabled,
      );
    },
  };
}

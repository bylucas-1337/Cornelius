import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { DiagnosticLog } from '../server/logs.js';
import { liveConfiguration } from '../server/live/configuration.js';
import { createGeminiLiveGateway } from '../server/live/gemini-gateway.js';
import type { LiveHandlers } from '../server/live/gateway.js';

type LoggedEntry = { event: string; details: Record<string, unknown> };

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  terminate() {
    this.readyState = WebSocket.CLOSED;
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  message(data: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }
}

function fixture(logs?: DiagnosticLog) {
  const socket = new FakeSocket();
  let targetUrl = '';
  const gateway = createGeminiLiveGateway('test-gemini-key', logs, (url) => {
    targetUrl = url;
    return socket as unknown as WebSocket;
  });
  const tools = [
    {
      name: 'fixture__lookup',
      description: 'Chercher une information de test.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1 },
          mode: { type: ['string', 'null'], enum: ['short', 'long', null] },
          priority: { type: 'string', enum: [1] },
        },
      },
    },
  ];
  const config = liveConfiguration(tools, undefined, undefined, { webSearch: false });
  const events: unknown[] = [];
  const handlers: LiveHandlers = {
    open() {
      events.push({ type: 'open' });
    },
    event(event) {
      events.push(event);
    },
    failure() {
      events.push({ type: 'failure' });
    },
  };
  return { socket, gateway, config, events, handlers, getTargetUrl: () => targetUrl };
}

test('Gemini Live ouvre le transport WebSocket et envoie les réglages/audio attendus', async () => {
  const f = fixture();
  const result = await f.gateway.create(f.config, 'ignored-sdp');
  assert.deepEqual(result.transport, { type: 'websocket' });
  const connection = f.gateway.attach(result.session.id, f.handlers);
  assert.match(f.getTargetUrl(), /v1beta\.GenerativeService\.BidiGenerateContent/u);
  assert.match(f.getTargetUrl(), /test-gemini-key/u);

  f.socket.open();
  const setup = JSON.parse(f.socket.sent[0]!) as {
    setup: {
      model: string;
      generationConfig: { responseModalities: string[] };
      inputAudioTranscription: Record<string, never>;
      outputAudioTranscription: Record<string, never>;
      tools: Array<{
        functionDeclarations: Array<{
          name: string;
          parameters: {
            type: string;
            additionalProperties?: boolean;
            properties: Record<string, { type: string; nullable?: boolean; enum?: unknown[] }>;
          };
        }>;
      }>;
    };
  };
  assert.equal(setup.setup.model, 'models/gemini-3.8-live');
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.deepEqual(setup.setup.inputAudioTranscription, {});
  assert.deepEqual(setup.setup.outputAudioTranscription, {});
  const functionDeclarations = setup.setup.tools[0]!.functionDeclarations;
  const parameters = functionDeclarations.find(
    (tool) => tool.name === 'fixture__lookup',
  )!.parameters;
  assert.equal(parameters.type, 'OBJECT');
  assert.equal(parameters.additionalProperties, undefined);
  assert.equal(parameters.properties.query!.type, 'STRING');
  assert.equal(parameters.properties.mode!.type, 'STRING');
  assert.equal(parameters.properties.mode!.nullable, true);
  assert.equal(parameters.properties.priority!.enum, undefined);

  f.socket.message({ setupComplete: {} });
  assert.ok(f.events.some((event) => (event as { type?: string }).type === 'open'));
  assert.ok(
    f.events.some(
      (event) =>
        (event as { type?: string }).type === 'session.started' &&
        (event as { session?: { id?: string } }).session?.id === result.session.id,
    ),
  );

  assert.ok('sendAudio' in connection);
  if (typeof connection.sendAudio !== 'function') throw new Error('Audio Gemini indisponible.');
  connection.sendAudio(Buffer.from([1, 0]));
  const audio = JSON.parse(f.socket.sent[1]!) as {
    realtimeInput: { audio: { mimeType: string; data: string } };
  };
  assert.deepEqual(audio.realtimeInput.audio, {
    mimeType: 'audio/pcm;rate=16000',
    data: 'AQA=',
  });
  connection.dispose();
});

test('Gemini traduit la recherche web en outil Tavily, sans activer Google Search', async () => {
  const f = fixture();
  const config = liveConfiguration([], undefined, undefined, { webSearch: true });
  const result = await f.gateway.create(config, '');
  f.gateway.attach(result.session.id, f.handlers);
  f.socket.open();

  const setup = JSON.parse(f.socket.sent[0]!) as {
    setup: {
      tools: Array<{
        googleSearch?: Record<string, never>;
        functionDeclarations?: Array<{
          name: string;
          parameters: { type: string; required?: string[] };
        }>;
      }>;
    };
  };
  const tools = setup.setup.tools;
  assert.equal(
    tools.some((tool) => tool.googleSearch),
    false,
  );
  const webSearch = tools
    .flatMap((tool) => tool.functionDeclarations ?? [])
    .find((tool) => tool.name === 'web__search');
  assert.equal(webSearch?.parameters.type, 'OBJECT');
  assert.deepEqual(webSearch?.parameters.required, ['query']);
});

test('Gemini utilise Google Search natif à la place de Tavily quand le réglage est désactivé', async () => {
  const f = fixture();
  f.gateway.setTavilySearchEnabled?.(false);
  const config = liveConfiguration([], undefined, undefined, { webSearch: true });
  const result = await f.gateway.create(config, '');
  f.gateway.attach(result.session.id, f.handlers);
  f.socket.open();

  const setup = JSON.parse(f.socket.sent[0]!) as {
    setup: {
      tools: Array<{
        googleSearch?: Record<string, never>;
        functionDeclarations?: Array<{ name: string }>;
      }>;
    };
  };
  assert.ok(setup.setup.tools.some((tool) => tool.googleSearch));
  assert.ok(
    !setup.setup.tools
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .some((tool) => tool.name === 'web__search'),
  );
});

test('Gemini transmet les citations Google Search à la carte du miroir', async () => {
  const f = fixture();
  f.gateway.setTavilySearchEnabled?.(false);
  const config = liveConfiguration([], undefined, undefined, { webSearch: true });
  const result = await f.gateway.create(config, '');
  f.gateway.attach(result.session.id, f.handlers);
  f.socket.open();

  f.socket.message({
    serverContent: {
      modelTurn: {
        parts: [{ text: 'Réponse avec sources.' }],
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://example.com/article', title: 'Article de test' } },
          ],
        },
      },
      turnComplete: true,
    },
  });

  const citationEvent = f.events.find((event) => {
    const record = event as {
      event?: {
        type?: string;
        item?: { content?: Array<{ annotations?: Array<{ url?: string; title?: string }> }> };
      };
    };
    return record.event?.type === 'response.output_item.done';
  }) as {
    event: {
      item: { content: Array<{ annotations: Array<{ url: string; title: string }> }> };
    };
  };
  assert.deepEqual(citationEvent.event.item.content[0]?.annotations, [
    {
      type: 'url_citation',
      url: 'https://example.com/article',
      title: 'Article de test',
    },
  ]);
});

test('Gemini ne configure aucun moteur de recherche quand la recherche web est désactivée', async () => {
  const f = fixture();
  f.gateway.setTavilySearchEnabled?.(false);
  const result = await f.gateway.create(f.config, '');
  f.gateway.attach(result.session.id, f.handlers);
  f.socket.open();

  const setup = JSON.parse(f.socket.sent[0]!) as {
    setup: { tools: Array<{ googleSearch?: unknown; functionDeclarations?: unknown[] }> };
  };
  assert.ok(
    !setup.setup.tools.some(
      (tool) =>
        tool.googleSearch ||
        (tool.functionDeclarations ?? []).some((item) => {
          const declaration = item as { name?: string };
          return declaration.name === 'web__search';
        }),
    ),
  );
});

test('Gemini journalise le détail structuré de ses erreurs et la limite des raisons WebSocket', async () => {
  const logs = new DiagnosticLog();
  const f = fixture(logs);
  const result = await f.gateway.create(f.config, '');
  f.gateway.attach(result.session.id, f.handlers);
  f.socket.open();

  f.socket.message({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'Quota exhausted.',
      details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
    },
  });
  f.socket.emit('close', 1011, Buffer.from('x'.repeat(123)));

  const entries = logs.snapshot().entries as LoggedEntry[];
  const providerError = entries.find((entry) => entry.details.providerError);
  assert.deepEqual(providerError?.details.providerError, {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Quota exhausted.',
    details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
  });
  const closed = entries.find((entry) => entry.event === 'WebSocket Gemini fermé');
  assert.equal(closed?.details.reasonBytes, 123);
  assert.equal(closed?.details.closeReasonLimitBytes, 123);
  assert.equal(closed?.details.reasonMayBeTruncated, true);
});

test('Gemini journalise le corps complet des refus HTTP avant l’ouverture WebSocket', async () => {
  const logs = new DiagnosticLog();
  const f = fixture(logs);
  const result = await f.gateway.create(f.config, '');
  f.gateway.attach(result.session.id, f.handlers);

  const response = Object.assign(new EventEmitter(), {
    statusCode: 429,
    statusMessage: 'Too Many Requests',
    headers: {
      'content-type': 'application/json',
      'x-goog-request-id': 'request-123',
    },
  });
  f.socket.emit('unexpected-response', {}, response);
  response.emit('data', Buffer.from('{"error":"quota","help":"https://example.test/quota"}'));
  response.emit('end');

  const entries = logs.snapshot().entries as LoggedEntry[];
  const rejected = entries.find((entry) => entry.event === 'Réponse HTTP de refus Gemini');
  assert.equal(rejected?.details.statusCode, 429);
  assert.equal(rejected?.details.body, '{"error":"quota","help":"https://example.test/quota"}');
  assert.equal(rejected?.details.googleRequestId, undefined);
  assert.equal(
    (rejected?.details.headers as Record<string, unknown>).googleRequestId,
    'request-123',
  );
  assert.equal(rejected?.details.bodyTruncated, false);
});

test('Gemini retransmet les transcriptions, les appels d’outils et les retours nommés', async () => {
  const f = fixture();
  const result = await f.gateway.create(f.config, '');
  const connection = f.gateway.attach(result.session.id, f.handlers);
  f.socket.open();
  f.socket.message({ setupComplete: {} });
  f.socket.message({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }],
      },
      inputTranscription: { text: 'Bonjour' },
      outputTranscription: { text: 'Bonjour, comment allez-vous ?' },
      interrupted: true,
    },
    toolCall: {
      functionCalls: [{ id: 'call-1', name: 'fixture__lookup', args: { query: 'météo' } }],
    },
  });

  assert.ok(
    f.events.some(
      (event) =>
        (event as { type?: string }).type === 'session.input_transcript.delta' &&
        (event as { delta?: string }).delta === 'Bonjour',
    ),
  );
  assert.ok(
    f.events.some(
      (event) =>
        (event as { type?: string }).type === 'session.output_transcript.delta' &&
        (event as { delta?: string }).delta === 'Bonjour, comment allez-vous ?',
    ),
  );
  assert.ok(
    f.events.some(
      (event) =>
        (event as { type?: string }).type === 'session.output_audio.delta' &&
        (event as { delta?: string }).delta === 'AAABAA==',
    ),
  );
  assert.ok(
    f.events.some(
      (event) => (event as { type?: string }).type === 'session.output_audio.interrupted',
    ),
  );
  const callEvent = f.events.find(
    (event) =>
      (event as { type?: string }).type === 'response.event' &&
      (event as { event?: { type?: string } }).event?.type === 'response.output_item.done',
  ) as { event: { item: { call_id: string; name: string; arguments: string } } };
  assert.deepEqual(callEvent.event.item, {
    type: 'function_call',
    call_id: 'call-1',
    name: 'fixture__lookup',
    arguments: '{"query":"météo"}',
  });

  connection.send({
    type: 'response.item.create',
    item: {
      type: 'function_call_output',
      call_id: 'call-1',
      output: JSON.stringify({ status: 'ok', summary: 'Donnée trouvée.' }),
    },
  } as never);
  assert.deepEqual(JSON.parse(f.socket.sent.at(-1)!), {
    toolResponse: {
      functionResponses: [
        {
          id: 'call-1',
          name: 'fixture__lookup',
          response: { status: 'ok', summary: 'Donnée trouvée.' },
        },
      ],
    },
  });
  connection.dispose();
});

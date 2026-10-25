import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { DiagnosticLog } from '../server/logs.js';
import { Mailer, type MailImageSource, type MailTransport } from '../server/mail.js';
import { MailRepository } from '../server/mail-store.js';
import { SmtpError, type MailMessage } from '../server/smtp.js';
import { openDatabase, ProfileRepository } from '../server/storage.js';
import { MAIL_PASSWORD_SECRET } from '../shared/mail.js';
import { fakeSmtp } from './helpers/smtp.js';

const image = Buffer.from('RIFF0000WEBPimage-de-test');

/** Envois simulés : chaque message est gardé, la réponse se règle par test. */
function transport(reply: () => Promise<unknown> = async () => ({})) {
  const sent: MailMessage[] = [];
  const verified: number[] = [];
  const value: MailTransport & { sent: MailMessage[]; verified: number[] } = {
    sent,
    verified,
    async send(_server, message) {
      sent.push(message);
      return reply();
    },
    async verify() {
      verified.push(1);
    },
  };
  return value;
}

function fixture(t: TestContext, options: { reply?: () => Promise<unknown> } = {}) {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-mail-'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const profiles = new ProfileRepository(db);
  const artus = profiles.create('Artus');
  const baptiste = profiles.create('Baptiste');
  const store = new MailRepository(db);
  const logs = new DiagnosticLog({ console: false });
  let password: string | undefined = 'mot-de-passe-app';
  const path = join(directory, 'phare.webp');
  writeFileSync(path, image);
  const requests: Parameters<MailImageSource['attachment']>[] = [];
  const images: MailImageSource = {
    attachment(profileId, input) {
      requests.push([profileId, input]);
      if (input.search === 'chat') return { summary: 'Aucune image récente ne correspond.' };
      return { image: { id: 'phare', prompt: 'Un phare dans la brume au lever du jour', path } };
    },
  };
  let clock = Date.parse('2026-10-23T08:00:00Z');
  const fake = transport(options.reply);
  const mailer = new Mailer(
    store,
    () => password,
    images,
    logs,
    () => clock,
    fake,
  );
  const configure = () => {
    store.saveSettings({
      enabled: true,
      host: 'smtp.example.test',
      port: 465,
      security: 'tls',
      username: '',
      fromAddress: 'cornelius@example.test',
      fromName: 'Cornelius',
    });
    store.addRecipient({ name: 'Artus', address: 'artus@example.test', profileId: artus.id });
    store.addRecipient({
      name: 'Baptiste',
      address: 'baptiste@example.test',
      profileId: baptiste.id,
    });
  };
  const input = (profileId: string | null, callId = 'appel-1') => ({
    profileId,
    profileName: profileId === artus.id ? 'Artus' : profileId === baptiste.id ? 'Baptiste' : null,
    interactionId: 'conversation',
    callId,
    shownImageId: 'phare',
  });
  const args = (values: Record<string, unknown> = {}) => ({
    recipient: 'moi',
    image: true,
    position: null,
    search: null,
    subject: null,
    message: null,
    ...values,
  });
  return {
    db,
    store,
    mailer,
    fake,
    logs,
    requests,
    artus,
    baptiste,
    configure,
    input,
    args,
    setPassword: (value: string | undefined) => (password = value),
    advance: (ms: number) => (clock += ms),
  };
}

test('outil absent tant que l’envoi n’est pas prêt, puis destinataires nommés', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.mailer.tools(), []);
  assert.deepEqual(f.mailer.missing(), ['le serveur SMTP', 'l’adresse d’envoi', 'un destinataire']);
  f.configure();
  f.setPassword(undefined);
  assert.deepEqual(f.mailer.missing(), ['le mot de passe']);
  assert.equal(f.mailer.handles('mail__send'), false);
  f.setPassword('mot-de-passe-app');
  const [tool] = f.mailer.tools(f.artus.id);
  assert.equal(tool?.name, 'mail__send');
  const recipient = (tool!.parameters.properties as Record<string, { enum?: string[] }>).recipient;
  assert.deepEqual(recipient?.enum, ['moi', 'Artus', 'Baptiste']);
  assert.match(tool!.description, /« moi » : la personne qui parle/u);
  // Aucune adresse ne passe au modèle.
  assert.doesNotMatch(JSON.stringify(tool), /@example\.test/u);
  f.store.saveSettings({ ...f.store.settings(), enabled: false });
  assert.deepEqual(f.mailer.tools(), []);
});

test('« envoie-moi cette image » : l’image affichée part à la personne qui parle', async (t) => {
  const f = fixture(t);
  f.configure();
  const result = await f.mailer.run(f.input(f.artus.id), f.args());
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.summary, 'E-mail envoyé à Artus, avec l’image.');
  assert.deepEqual(f.requests[0], [f.artus.id, { shownId: 'phare', position: null, search: null }]);
  const message = f.fake.sent[0]!;
  assert.deepEqual(message.to, { name: 'Artus', address: 'artus@example.test' });
  assert.deepEqual(message.from, { name: 'Cornelius', address: 'cornelius@example.test' });
  assert.equal(message.subject, 'Image de Cornelius : Un phare dans la brume au lever du jour');
  assert.match(message.text, /à la demande de Artus\.$/u);
  assert.equal(
    message.attachments?.[0]?.filename,
    'cornelius-un-phare-dans-la-brume-au-lever-du-jour.webp',
  );
  assert.equal(message.attachments?.[0]?.contentType, 'image/webp');
  assert.deepEqual(message.attachments?.[0]?.content, image);
  // Le journal garde le nom, jamais l’adresse.
  const entries = JSON.stringify(f.logs.snapshot());
  assert.match(entries, /E-mail envoyé/u);
  assert.doesNotMatch(entries, /artus@example\.test/u);
});

test('à quelqu’un d’autre, par son nom, sans accent ni majuscule ; par sujet ou par position', async (t) => {
  const f = fixture(t);
  f.configure();
  const result = await f.mailer.run(
    f.input(f.artus.id),
    f.args({ recipient: 'baptiste', search: 'phare', message: 'Regarde ce que j’ai demandé !' }),
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(f.fake.sent[0]!.to.address, 'baptiste@example.test');
  assert.match(f.fake.sent[0]!.text, /^Regarde ce que j’ai demandé !/u);
  // Une recherche ou une position ignore l’image affichée.
  assert.deepEqual(f.requests[0]![1], { shownId: null, position: null, search: 'phare' });
  const missing = await f.mailer.run(f.input(f.artus.id, 'appel-2'), f.args({ search: 'chat' }));
  assert.equal(missing.status, 'failed');
  assert.match(missing.summary, /Aucune image récente/u);
  const stranger = await f.mailer.run(
    f.input(f.artus.id, 'appel-3'),
    f.args({ recipient: 'Lucie' }),
  );
  assert.match(stranger.summary, /« Lucie » n’est pas dans la liste/u);
  assert.equal(f.fake.sent.length, 1);
});

test('plusieurs adresses pour une personne : « moi » prend la première, les autres par leur nom', async (t) => {
  const f = fixture(t);
  f.configure();
  f.store.addRecipient({
    name: 'Artus travail',
    address: 'artus@travail.example.test',
    profileId: f.artus.id,
  });
  const [tool] = f.mailer.tools(f.artus.id);
  assert.match(tool!.description, /« moi » : la personne qui parle \(Artus\)\./u);
  assert.match(tool!.description, /Ses autres adresses, .*: Artus travail\./u);
  const [other] = f.mailer.tools(f.baptiste.id);
  assert.doesNotMatch(other!.description, /Ses autres adresses/u);
  await f.mailer.run(f.input(f.artus.id), f.args());
  await f.mailer.run(f.input(f.artus.id, 'appel-2'), f.args({ recipient: 'artus travail' }));
  assert.deepEqual(
    f.fake.sent.map((message) => message.to.address),
    ['artus@example.test', 'artus@travail.example.test'],
  );
});

test('« moi » exige une personne reconnue qui a son adresse', async (t) => {
  const f = fixture(t);
  f.configure();
  const anonymous = await f.mailer.run(f.input(null), f.args());
  assert.equal(anonymous.error?.code, 'not_found');
  assert.match(anonymous.summary, /Je ne sais pas qui parle/u);
  f.store.deleteRecipient(f.store.recipients().find((r) => r.name === 'Baptiste')!.id);
  const unknown = await f.mailer.run(f.input(f.baptiste.id, 'appel-2'), f.args());
  assert.match(unknown.summary, /Aucune adresse e-mail pour Baptiste/u);
  assert.equal(f.fake.sent.length, 0);
});

test('un message sans image ; rien à envoyer est refusé', async (t) => {
  const f = fixture(t);
  f.configure();
  const empty = await f.mailer.run(f.input(f.artus.id), f.args({ image: false }));
  assert.equal(empty.error?.code, 'invalid_params');
  const text = await f.mailer.run(
    f.input(f.artus.id, 'appel-2'),
    f.args({ image: false, subject: 'Adresse du restaurant', message: '12 rue des Lilas, Rennes' }),
  );
  assert.equal(text.summary, 'E-mail envoyé à Artus.');
  assert.equal(f.fake.sent[0]!.subject, 'Adresse du restaurant');
  assert.deepEqual(f.fake.sent[0]!.attachments, []);
  assert.equal(f.requests.length, 0);
});

test('un même appel rejoué n’envoie pas deux fois ; un envoi incertain n’est pas répété', async (t) => {
  let fail = false;
  const f = fixture(t, {
    reply: async () => {
      if (fail) throw new SmtpError('timeout', 'Envoi incertain.', true);
      return {};
    },
  });
  f.configure();
  const first = await f.mailer.run(f.input(f.artus.id), f.args());
  const again = await f.mailer.run(f.input(f.artus.id), f.args());
  assert.deepEqual(again, first);
  assert.equal(f.fake.sent.length, 1);
  fail = true;
  const uncertain = await f.mailer.run(f.input(f.artus.id, 'appel-2'), f.args());
  assert.equal(uncertain.status, 'unknown');
  assert.match(uncertain.summary, /Ne pas renvoyer/u);
  assert.equal(f.mailer.view(null, null).lastSend?.status, 'unknown');
});

test('vingt e-mails par heure au plus ; un échec certain ne compte pas', async (t) => {
  let refuse = true;
  const f = fixture(t, {
    reply: async () => {
      if (refuse) throw new SmtpError('rejected', 'Adresse du destinataire refusée.');
      return {};
    },
  });
  f.configure();
  const refused = await f.mailer.run(f.input(f.artus.id, 'refus'), f.args());
  assert.equal(refused.status, 'failed');
  assert.match(refused.summary, /E-mail non envoyé à Artus\. Adresse du destinataire refusée\./u);
  refuse = false;
  for (let index = 0; index < 20; index++) {
    const result = await f.mailer.run(f.input(f.artus.id, `appel-${index}`), f.args());
    assert.equal(result.status, 'succeeded', `envoi ${index}`);
  }
  const limited = await f.mailer.run(f.input(f.artus.id, 'appel-21'), f.args());
  assert.equal(limited.error?.code, 'rate_limited');
  f.advance(3_600_001);
  const later = await f.mailer.run(f.input(f.artus.id, 'appel-22'), f.args());
  assert.equal(later.status, 'succeeded');
});

test('avec un vrai échange SMTP : l’image arrive en pièce jointe', async (t) => {
  const smtp = await fakeSmtp({ security: 'tls' });
  t.after(() => smtp.close());
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-mail-'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'image.webp');
  writeFileSync(path, image);
  const store = new MailRepository(db);
  store.saveSettings({
    enabled: true,
    host: '127.0.0.1',
    port: smtp.port,
    security: 'tls',
    username: smtp.username,
    fromAddress: 'cornelius@example.test',
    fromName: 'Cornelius',
  });
  store.addRecipient({ name: 'Baptiste', address: 'baptiste@example.test', profileId: null });
  const mailer = new Mailer(
    store,
    () => smtp.password,
    { attachment: () => ({ image: { id: 'x', prompt: 'Un phare', path } }) },
    undefined,
    Date.now,
    undefined,
    smtp.ca,
  );
  assert.deepEqual(await mailer.test(null), {
    ok: true,
    summary: 'Connexion réussie : le serveur accepte ce compte.',
  });
  const result = await mailer.run(
    {
      profileId: null,
      profileName: null,
      interactionId: 'conversation',
      callId: 'appel',
      shownImageId: null,
    },
    {
      recipient: 'Baptiste',
      image: true,
      position: null,
      search: null,
      subject: null,
      message: null,
    },
  );
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(smtp.messages[0]?.to, ['baptiste@example.test']);
  assert.match(
    smtp.messages[0]!.data,
    /Content-Disposition: attachment; filename="cornelius-un-phare\.webp"/u,
  );
  assert.match(
    smtp.messages[0]!.data,
    /^Content-Type: image\/webp; name="cornelius-un-phare\.webp"$/mu,
  );
});

test('administration : réglages, mot de passe, destinataires, essai ; rien sur le miroir', async (t) => {
  const fake = transport();
  const services = await createApp(
    {
      databasePath: ':memory:',
      adminPassword: 'mail-test-only-1234',
      origins: ['http://localhost'],
      secureCookies: false,
    },
    { timers: false, mailTransport: fake },
  );
  await services.app.ready();
  t.after(() => services.app.close());
  const login = await services.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin: 'http://localhost' },
    payload: { password: 'mail-test-only-1234' },
  });
  const cookie = login.cookies.find((entry) => entry.name === 'cornelius_admin')!;
  const headers = { origin: 'http://localhost', cookie: `${cookie.name}=${cookie.value}` };
  const call = (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    services.app.inject(
      payload === undefined ? { method, url, headers } : { method, url, headers, payload },
    );

  const initial = (await call('GET', '/api/admin/mail')).json();
  assert.equal(initial.ready, false);
  assert.equal(initial.settings.enabled, false);
  assert.equal(
    (await services.app.inject({ method: 'GET', url: '/api/admin/mail' })).statusCode,
    401,
  );

  const badFrom = await call('PUT', '/api/admin/mail/settings', { fromAddress: 'pas-une-adresse' });
  assert.equal(badFrom.statusCode, 400);
  assert.equal(badFrom.json().field, 'fromAddress');
  const settings = await call('PUT', '/api/admin/mail/settings', {
    enabled: true,
    host: 'SMTP.Gmail.com',
    port: 465,
    security: 'tls',
    fromAddress: 'cornelius.maison@gmail.com',
  });
  assert.equal(settings.statusCode, 200, settings.body);
  assert.equal(settings.json().settings.host, 'smtp.gmail.com');
  assert.deepEqual(settings.json().missing, ['le mot de passe', 'un destinataire']);

  // Un mot de passe d’application Gmail se colle avec ses espaces.
  const saved = await call('PUT', '/api/admin/mail/password', { value: 'abcd efgh ijkl mnop' });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().password, { configured: true, source: 'admin', hint: 'mnop' });
  const secrets = (await call('GET', '/api/admin/secrets')).json().secrets as { env: string }[];
  assert.ok(secrets.some((secret) => secret.env === MAIL_PASSWORD_SECRET));

  const profile = (await call('POST', '/api/admin/profiles', { name: 'Baptiste' })).json();
  const profileId = profile.id ?? profile.profile?.id;
  assert.ok(profileId, JSON.stringify(profile));
  const added = await call('POST', '/api/admin/mail/recipients', {
    name: 'Baptiste',
    address: 'baptiste@example.test',
    profileId,
  });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal(added.json().ready, true);
  for (const [payload, message] of [
    [{ name: 'baptiste', address: 'b2@example.test', profileId: null }, /déjà dans la liste/u],
    [{ name: 'Moi', address: 'moi@example.test', profileId: null }, /« Moi »/u],
    [{ name: 'Léa', address: 'lea', profileId: null }, /Adresse e-mail invalide/u],
  ] as const) {
    const refused = await call('POST', '/api/admin/mail/recipients', payload);
    assert.equal(refused.statusCode, 400);
    assert.match(refused.json().error, message);
  }
  // Une deuxième adresse pour le même profil, sous un autre nom.
  const work = await call('POST', '/api/admin/mail/recipients', {
    name: 'Baptiste travail',
    address: 'baptiste@travail.example.test',
    profileId,
  });
  assert.equal(work.statusCode, 200, work.body);
  assert.equal(work.json().recipients.length, 2);
  const recipientId = added.json().recipients[0].id as string;

  const verify = (await call('POST', '/api/admin/mail/test', { recipientId: null })).json();
  assert.equal(verify.ok, true);
  assert.equal(fake.verified.length, 1);
  const trial = (await call('POST', '/api/admin/mail/test', { recipientId })).json();
  assert.equal(trial.summary, 'E-mail d’essai envoyé à Baptiste.');
  assert.equal(fake.sent[0]?.to.address, 'baptiste@example.test');

  // Les adresses ne sont jamais diffusées au miroir.
  const state = await services.app.inject({ method: 'GET', url: '/api/state' });
  assert.doesNotMatch(state.body, /baptiste@example\.test|cornelius\.maison/u);

  // Supprimer le profil supprime son adresse.
  assert.equal((await call('DELETE', `/api/admin/profiles/${profileId}`)).statusCode, 200);
  assert.deepEqual((await call('GET', '/api/admin/mail')).json().recipients, []);
});

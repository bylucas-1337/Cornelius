import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAIL_PASSWORD_SECRET,
  MAIL_RECIPIENTS_MAX,
  type MailRecipient,
  type MailSettings,
} from '../shared/mail.js';
import { profileNameKey } from '../shared/profile-names.js';
import { compile } from '../shared/validation.js';
import type { Mailer } from './mail.js';
import type { MailRepository } from './mail-store.js';
import { secretValueError, type SecretStore } from './secrets.js';
import { mailAddressError } from './smtp.js';
import type { ProfileRepository } from './storage.js';

const text = (max: number) => ({
  type: 'string',
  maxLength: max,
  pattern: '^[^\\u0000-\\u001f\\u007f]*$',
});

const settingsSchema = compile<Partial<MailSettings>>({
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    enabled: { type: 'boolean' },
    host: { type: 'string', maxLength: 253, pattern: '^([A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*)?$' },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    security: { enum: ['tls', 'starttls'] },
    username: text(254),
    fromAddress: text(254),
    fromName: text(60),
  },
});

const recipientSchema = compile<Pick<MailRecipient, 'name' | 'address' | 'profileId'>>({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'address', 'profileId'],
  properties: {
    name: { ...text(40), minLength: 1 },
    address: text(254),
    profileId: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
  },
});

const testSchema = compile<{ recipientId: string | null }>({
  type: 'object',
  additionalProperties: false,
  required: ['recipientId'],
  properties: { recipientId: { type: ['string', 'null'], minLength: 1, maxLength: 64 } },
});

export function registerMail(
  app: FastifyInstance,
  services: {
    mailer: Mailer;
    store: MailRepository;
    profiles: ProfileRepository;
    secrets: SecretStore;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Les réglages ont changé : l'outil vocal et sa liste de destinataires aussi, peut-être. */
    onChanged(): void;
  },
) {
  const { mailer, store, profiles, secrets, requireAdmin, onChanged } = services;
  const admin = { preHandler: requireAdmin };
  const view = () =>
    mailer.view(secrets.source(MAIL_PASSWORD_SECRET), secrets.hint(MAIL_PASSWORD_SECRET));

  /** Nom, adresse et profil d'un destinataire, ou l'erreur à afficher sous le champ. */
  const recipientError = (
    input: Pick<MailRecipient, 'name' | 'address' | 'profileId'>,
    exceptId: string | null,
  ): string | null => {
    const name = input.name.trim();
    const key = profileNameKey(name);
    if (!key) return 'Nom attendu.';
    if (key === 'moi') return '« Moi » désigne déjà la personne qui parle : choisissez un prénom.';
    const others = store.recipients().filter((recipient) => recipient.id !== exceptId);
    if (others.some((recipient) => profileNameKey(recipient.name) === key))
      return `« ${name} » est déjà dans la liste.`;
    const address = mailAddressError(input.address);
    if (address) return address;
    if (input.profileId !== null && !profiles.get(input.profileId)) return 'Profil inconnu.';
    return null;
  };
  const clean = (input: Pick<MailRecipient, 'name' | 'address' | 'profileId'>) => ({
    name: input.name.replace(/\s+/gu, ' ').trim(),
    address: input.address.trim(),
    profileId: input.profileId,
  });

  app.get('/api/admin/mail', admin, async () => view());

  app.put<{ Body: Partial<MailSettings> }>(
    '/api/admin/mail/settings',
    admin,
    async (request, reply) => {
      if (!settingsSchema(request.body))
        return reply.code(400).send({ error: 'Réglages d’e-mail invalides.' });
      const next = { ...store.settings(), ...request.body };
      next.host = next.host.trim().toLowerCase();
      next.username = next.username.trim();
      next.fromAddress = next.fromAddress.trim();
      next.fromName = next.fromName.replace(/\s+/gu, ' ').trim();
      if (next.fromAddress) {
        const error = mailAddressError(next.fromAddress);
        if (error) return reply.code(400).send({ error, field: 'fromAddress' });
      }
      store.saveSettings(next);
      onChanged();
      return view();
    },
  );

  // Mot de passe du compte : les espaces d'un mot de passe d'application (Gmail) sont retirés.
  app.put<{ Body: { value?: unknown } }>(
    '/api/admin/mail/password',
    admin,
    async (request, reply) => {
      const raw = request.body?.value;
      const value = typeof raw === 'string' ? raw.replace(/\s+/gu, '') : raw;
      const error = secretValueError(value);
      if (error) return reply.code(400).send({ error });
      secrets.set(MAIL_PASSWORD_SECRET, value as string);
      onChanged();
      return view();
    },
  );
  app.delete('/api/admin/mail/password', admin, async () => {
    secrets.delete(MAIL_PASSWORD_SECRET);
    onChanged();
    return view();
  });

  app.post<{ Body: Pick<MailRecipient, 'name' | 'address' | 'profileId'> }>(
    '/api/admin/mail/recipients',
    admin,
    async (request, reply) => {
      if (!recipientSchema(request.body))
        return reply.code(400).send({ error: 'Destinataire invalide.' });
      if (store.recipients().length >= MAIL_RECIPIENTS_MAX)
        return reply.code(409).send({ error: `${MAIL_RECIPIENTS_MAX} destinataires au plus.` });
      const input = clean(request.body);
      const error = recipientError(input, null);
      if (error) return reply.code(400).send({ error });
      store.addRecipient(input);
      onChanged();
      return view();
    },
  );
  app.put<{
    Params: { id: string };
    Body: Pick<MailRecipient, 'name' | 'address' | 'profileId'>;
  }>('/api/admin/mail/recipients/:id', admin, async (request, reply) => {
    if (!store.recipient(request.params.id))
      return reply.code(404).send({ error: 'Destinataire inconnu.' });
    if (!recipientSchema(request.body))
      return reply.code(400).send({ error: 'Destinataire invalide.' });
    const input = clean(request.body);
    const error = recipientError(input, request.params.id);
    if (error) return reply.code(400).send({ error });
    store.updateRecipient(request.params.id, input);
    onChanged();
    return view();
  });
  app.delete<{ Params: { id: string } }>(
    '/api/admin/mail/recipients/:id',
    admin,
    async (request, reply) => {
      if (!store.deleteRecipient(request.params.id))
        return reply.code(404).send({ error: 'Destinataire inconnu.' });
      onChanged();
      return view();
    },
  );

  app.post<{ Body: { recipientId: string | null } }>(
    '/api/admin/mail/test',
    admin,
    async (request, reply) => {
      if (!testSchema(request.body)) return reply.code(400).send({ error: 'Essai invalide.' });
      const result = await mailer.test(request.body.recipientId);
      return { ...result, mail: view() };
    },
  );
}

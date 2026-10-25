import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_MAIL_SETTINGS,
  type MailRecipient,
  type MailSecurity,
  type MailSettings,
} from '../shared/mail.js';

/**
 * Envoi par e-mail : un serveur pour le foyer et la liste des destinataires. Les adresses ne
 * sont jamais dans la table des profils, diffusée au miroir ; un profil supprimé emporte la
 * sienne.
 */
export const mailMigration = `CREATE TABLE IF NOT EXISTS mail_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 465 CHECK (port BETWEEN 1 AND 65535),
  security TEXT NOT NULL DEFAULT 'tls' CHECK (security IN ('tls', 'starttls')),
  username TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT 'Cornelius'
) STRICT;
INSERT OR IGNORE INTO mail_settings (id) VALUES (1);
CREATE TABLE IF NOT EXISTS mail_recipients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  profile_id TEXT UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;`;

/**
 * Plusieurs adresses pour un même profil (personnelle, travail) : la contrainte d'unicité du
 * profil disparaît. L'ordre est gardé : « envoie-moi » vise la première adresse du profil.
 */
export const mailRecipientsMigration = `CREATE TABLE mail_recipients_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;
INSERT INTO mail_recipients_v2 (id, name, address, profile_id, created_at)
  SELECT id, name, address, profile_id, created_at FROM mail_recipients ORDER BY created_at, rowid;
DROP TABLE mail_recipients;
ALTER TABLE mail_recipients_v2 RENAME TO mail_recipients;`;

const recipientOf = (row: Record<string, unknown>): MailRecipient => ({
  id: String(row.id),
  name: String(row.name),
  address: String(row.address),
  profileId: row.profile_id === null ? null : String(row.profile_id),
  createdAt: Number(row.created_at),
});

export class MailRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  settings(): MailSettings {
    const row = this.db.prepare('SELECT * FROM mail_settings WHERE id = 1').get();
    if (!row) return { ...DEFAULT_MAIL_SETTINGS };
    return {
      enabled: row.enabled === 1,
      host: String(row.host),
      port: Number(row.port),
      security: (row.security === 'starttls' ? 'starttls' : 'tls') as MailSecurity,
      username: String(row.username),
      fromAddress: String(row.from_address),
      fromName: String(row.from_name),
    };
  }

  saveSettings(settings: MailSettings): MailSettings {
    this.db
      .prepare(
        'UPDATE mail_settings SET enabled = ?, host = ?, port = ?, security = ?, username = ?, from_address = ?, from_name = ? WHERE id = 1',
      )
      .run(
        settings.enabled ? 1 : 0,
        settings.host,
        settings.port,
        settings.security,
        settings.username,
        settings.fromAddress,
        settings.fromName,
      );
    return this.settings();
  }

  recipients(): MailRecipient[] {
    return this.db
      .prepare('SELECT * FROM mail_recipients ORDER BY created_at, rowid')
      .all()
      .map(recipientOf);
  }

  recipient(id: string): MailRecipient | null {
    const row = this.db.prepare('SELECT * FROM mail_recipients WHERE id = ?').get(id);
    return row ? recipientOf(row) : null;
  }

  addRecipient(input: Pick<MailRecipient, 'name' | 'address' | 'profileId'>): MailRecipient {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO mail_recipients (id, name, address, profile_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name, input.address, input.profileId, this.now());
    return this.recipient(id)!;
  }

  updateRecipient(
    id: string,
    input: Pick<MailRecipient, 'name' | 'address' | 'profileId'>,
  ): MailRecipient | null {
    this.db
      .prepare('UPDATE mail_recipients SET name = ?, address = ?, profile_id = ? WHERE id = ?')
      .run(input.name, input.address, input.profileId, id);
    return this.recipient(id);
  }

  deleteRecipient(id: string): boolean {
    return this.db.prepare('DELETE FROM mail_recipients WHERE id = ?').run(id).changes > 0;
  }
}

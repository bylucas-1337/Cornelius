/** Envoi par e-mail : réglages du serveur SMTP et destinataires du foyer. */

export type MailSecurity = 'tls' | 'starttls';

/** Mot de passe du compte d'envoi, rangé avec les autres clés (jamais dans ces réglages). */
export const MAIL_PASSWORD_SECRET = 'CORNELIUS_SMTP_PASSWORD';

/** Destinataires au plus : la liste est donnée en entier au modèle. */
export const MAIL_RECIPIENTS_MAX = 20;

export interface MailSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  /** Identifiant du compte ; vide : l'adresse d'envoi. */
  username: string;
  fromAddress: string;
  fromName: string;
}

export interface MailRecipient {
  id: string;
  /** Nom dit à la voix : « envoie-la à Baptiste ». */
  name: string;
  address: string;
  /** Profil relié : « envoie-moi » vise ce destinataire quand ce profil parle. */
  profileId: string | null;
  createdAt: number;
}

export interface MailLastSend {
  at: number;
  status: 'sent' | 'failed' | 'unknown';
  recipient: string;
  summary: string;
}

export interface MailView {
  settings: MailSettings;
  recipients: MailRecipient[];
  password: { configured: boolean; source: 'admin' | 'env' | null; hint: string | null };
  /** Prêt : activé, serveur, adresse, mot de passe et au moins un destinataire. */
  ready: boolean;
  /** Ce qui manque encore, en clair. */
  missing: string[];
  lastSend: MailLastSend | null;
}

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  enabled: false,
  host: '',
  port: 465,
  security: 'tls',
  username: '',
  fromAddress: '',
  fromName: 'Cornelius',
};

/** Fournisseurs courants : adresse, port et chiffrement à reprendre tels quels. */
export const MAIL_PRESETS: {
  id: string;
  label: string;
  host: string;
  port: number;
  security: MailSecurity;
  /** Page où créer un mot de passe d'application, quand le fournisseur en exige un. */
  passwordUrl: string | null;
}[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 465,
    security: 'tls',
    passwordUrl: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'icloud',
    label: 'iCloud',
    host: 'smtp.mail.me.com',
    port: 587,
    security: 'starttls',
    passwordUrl: 'https://account.apple.com',
  },
  {
    id: 'orange',
    label: 'Orange',
    host: 'smtp.orange.fr',
    port: 465,
    security: 'tls',
    passwordUrl: null,
  },
  {
    id: 'free',
    label: 'Free',
    host: 'smtp.free.fr',
    port: 465,
    security: 'tls',
    passwordUrl: null,
  },
  { id: 'sfr', label: 'SFR', host: 'smtp.sfr.fr', port: 465, security: 'tls', passwordUrl: null },
  { id: 'ovh', label: 'OVH', host: 'ssl0.ovh.net', port: 465, security: 'tls', passwordUrl: null },
];

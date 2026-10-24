import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_ADMIN_PASSWORD } from '../server/config.js';

const path = '.env';
const defaultPassword = DEFAULT_ADMIN_PASSWORD;
if (!existsSync(path)) {
  writeFileSync(
    path,
    [
      'PORT=3000',
      'CORNELIUS_DATABASE=data/cornelius.sqlite',
      'CORNELIUS_ADMIN_PASSWORD=' + defaultPassword,
      'CORNELIUS_PERCEPTION_TOKEN=' + randomBytes(32).toString('base64url'),
      'GEMINI_API_KEY=',
      'OPENAI_API_KEY=',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.info('Configuration locale créée dans .env.');
} else {
  let value = readFileSync(path, 'utf8');
  value = value.replace(/^CORNELIUS_(?:ADMIN|KIOSK)_TOKEN=.*\r?\n?/gm, '');
  if (!/^CORNELIUS_ADMIN_PASSWORD=.+$/m.test(value))
    value =
      value.replace(/^CORNELIUS_ADMIN_PASSWORD=.*\r?\n?/m, '') +
      '\nCORNELIUS_ADMIN_PASSWORD=' +
      defaultPassword +
      '\n';
  if (!/^CORNELIUS_PERCEPTION_TOKEN=.+$/m.test(value))
    value =
      value.replace(/^CORNELIUS_PERCEPTION_TOKEN=.*\r?\n?/m, '') +
      '\nCORNELIUS_PERCEPTION_TOKEN=' +
      randomBytes(32).toString('base64url') +
      '\n';
  if (!/^GEMINI_API_KEY=/m.test(value)) value += 'GEMINI_API_KEY=\n';
  if (!/^OPENAI_API_KEY=/m.test(value)) value += 'OPENAI_API_KEY=\n';
  writeFileSync(path, value, { mode: 0o600 });
  console.info('Configuration conservée ; mot de passe et champs matériels vérifiés.');
}

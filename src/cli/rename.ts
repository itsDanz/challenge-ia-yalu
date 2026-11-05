/** `npm run rename -- "Nombre del equipo"`: PATCH /api/me (máx. 30 caracteres). */
import { clientFromEnv, runCli } from './env.ts';

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('Uso: npm run rename -- "Nombre del equipo"');
  process.exit(1);
}
await runCli(() => clientFromEnv().rename(name));

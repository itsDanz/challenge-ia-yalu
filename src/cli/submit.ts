/** `npm run submit -- <repo_url> [commit]`: registers the submission (default commit = HEAD). */
import { execSync } from 'node:child_process';
import { clientFromEnv, runCli } from './env.ts';

const repoUrl = process.argv[2];
if (!repoUrl) {
  console.error('Uso: npm run submit -- <repo_url> [commit]');
  process.exit(2);
}
let commit = process.argv[3];
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    console.error('No se pudo leer git rev-parse HEAD; pasa el commit como segundo argumento.');
    process.exit(2);
  }
}
console.log(`Registrando ${repoUrl} @ ${commit}`);
await runCli(() => clientFromEnv().submission(repoUrl, commit));

/** `npm run practice -- [casa-basico|casa-aleatorio] [1|2]`: creates a practice game. */
import { clientFromEnv, runCli } from './env.ts';

const opponent = process.argv[2] ?? 'casa-basico';
const first = Number(process.argv[3] ?? 1);
if (first !== 1 && first !== 2) {
  console.error('Uso: npm run practice -- [casa-basico|casa-aleatorio] [1|2]');
  process.exit(2);
}
await runCli(() => clientFromEnv().practice(opponent, first));

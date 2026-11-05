/** `npm run me`: GET /api/me with TEAM_TOKEN (checks the token works). */
import { clientFromEnv, runCli } from './env.ts';

await runCli(() => clientFromEnv().me());

/** `npm run mock`: local mock arbiter on :8790 (MOCK_PORT). Tokens from MOCK_TOKENS=a,b. */
import { startMockArbiter } from '../mock/mockArbiter.ts';

const port = Number(process.env.MOCK_PORT ?? 8790);
const tokenList = (process.env.MOCK_TOKENS ?? 'token-equipo3,token-rival').split(',').map((t) => t.trim()).filter(Boolean);
const tokens = Object.fromEntries(tokenList.map((t, i) => [t, { id: `eq${i + 1}`, name: i === 0 ? 'Equipo 3' : `Rival ${i}` }]));
const mock = await startMockArbiter({
  port,
  host: process.env.MOCK_HOST ?? '127.0.0.1',
  tokens,
  absentMs: Number(process.env.MOCK_ABSENT_MS ?? 30_000),
  deadlineMs: Number(process.env.MOCK_DEADLINE_MS ?? 3000),
  log: (l) => console.log(l),
});
console.log(`Árbitro simulado en ${mock.url}
Tokens: ${tokenList.join(', ')}

Uso:
  ARBITRO_URL=${mock.url} TEAM_TOKEN=${tokenList[0]} npm start
  ARBITRO_URL=${mock.url} TEAM_TOKEN=${tokenList[0]} npm run practice -- casa-basico 1
  curl -X POST ${mock.url}/admin/match -H 'Content-Type: application/json' \\
       -d '{"team1":"${tokenList[0]}","team2":"${tokenList[1] ?? tokenList[0]}"}'   # sólo en el mock
`);
process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));

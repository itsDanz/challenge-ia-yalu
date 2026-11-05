/**
 * Series between two bots through the local mock arbiter (`npm run mock`), alternating who opens.
 * Games are played one at a time, so the two bots never compete for CPU. Both engines are usually
 * deterministic, so each pair of games starts from a different 2-move opening (played once from each
 * side) to avoid replaying the same game over and over.
 *
 *   node tools/match.ts [games=10] [url=http://127.0.0.1:8790] [tokenA=token-equipo3] [tokenB=token-rival]
 *
 * Both bots must already be running against the mock, each with its own token.
 */
const games = Number(process.argv[2] ?? 10);
const url = (process.argv[3] ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
const tokenA = process.argv[4] ?? 'token-equipo3';
const tokenB = process.argv[5] ?? 'token-rival';

interface GameRecord {
  status: string;
  players: Record<'1' | '2', { name: string }>;
  moves: Array<{ by: number; ms?: number }>;
  result: { winner: 1 | 2 | null; reason: string } | null;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${url}${path}`, { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = (await res.json()) as T;
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

// Columns are 0-based (3 and 4 are the two central ones).
const OPENINGS = [[3, 3], [3, 4], [4, 3], [3, 2], [2, 4], [4, 5], [5, 3], [2, 5], [3, 5], [4, 2]];

const score = { A: 0, B: 0, draw: 0 };
const maxMs = { A: 0, B: 0 };
let nameA = 'A';
let nameB = 'B';

for (let i = 0; i < games; i++) {
  const aOpens = i % 2 === 0;
  const opening = OPENINGS[Math.floor(i / 2) % OPENINGS.length];
  const [team1, team2] = aOpens ? [tokenA, tokenB] : [tokenB, tokenA];
  const created = await json<{ game_id: string }>('/admin/match', {
    method: 'POST',
    body: JSON.stringify({ team1, team2, opening }),
  });
  let game: GameRecord;
  for (;;) {
    game = await json<GameRecord>(`/api/games/${created.game_id}`);
    if (game.status === 'finished') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const aSide = aOpens ? 1 : 2;
  nameA = game.players[String(aSide) as '1' | '2'].name;
  nameB = game.players[String(3 - aSide) as '1' | '2'].name;
  for (const m of game.moves) {
    const who = m.by === aSide ? 'A' : 'B';
    maxMs[who] = Math.max(maxMs[who], m.ms ?? 0);
  }
  const r = game.result!;
  const winner = r.winner === null ? 'empate' : r.winner === aSide ? nameA : nameB;
  if (r.winner === null) score.draw++;
  else if (r.winner === aSide) score.A++;
  else score.B++;
  const shown = opening.map((c) => c + 1).join('-');
  console.log(`#${i + 1} apertura ${shown}, abre ${aOpens ? nameA : nameB}: gana ${winner} (${r.reason}, ${game.moves.length} jugadas)`);
}

console.log(`\n${nameA}: ${score.A}  ·  ${nameB}: ${score.B}  ·  empates: ${score.draw}`);
console.log(`Jugada más lenta (ms desde served_at): ${nameA} ${maxMs.A} · ${nameB} ${maxMs.B}`);

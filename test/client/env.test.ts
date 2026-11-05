import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/cli/env.ts';

describe('parseEnv (.env loader used by npm start)', () => {
  it('reads KEY=VALUE, quotes, export prefix and ignores comments', () => {
    expect(
      parseEnv('# c\nARBITRO_URL=https://a.b/ # comentario\nexport TEAM_TOKEN="x y"\nBOT_THINK_MS=\'1500\'\n\nbasura\n'),
    ).toEqual({ ARBITRO_URL: 'https://a.b/', TEAM_TOKEN: 'x y', BOT_THINK_MS: '1500' });
  });
});

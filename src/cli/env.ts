/** Shared CLI helpers: .env loading and the arbiter client built from the environment. */

import { existsSync, readFileSync } from 'node:fs';
import { ArbiterClient } from '../client/arbiterClient.ts';

/** Parses KEY=VALUE lines (quotes optional, # comments). Does not override existing vars. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function clientFromEnv(): ArbiterClient {
  loadDotEnv();
  const baseUrl = process.env.ARBITRO_URL;
  const token = process.env.TEAM_TOKEN;
  if (!baseUrl || !token) {
    console.error('Faltan ARBITRO_URL y/o TEAM_TOKEN (variables de entorno o archivo .env).');
    process.exit(2);
  }
  return new ArbiterClient({ baseUrl, token });
}

export async function runCli(fn: () => Promise<unknown>): Promise<void> {
  try {
    const out = await fn();
    if (out !== undefined) console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    console.error(`Error${e.status ? ` ${e.status}` : ''}${e.code ? ` ${e.code}` : ''}: ${e.message ?? err}`);
    process.exitCode = 1;
  }
}

import type { Health, TournamentStatus } from '../api.ts';

export type ServerState = 'checking' | 'up' | 'down';

interface HeaderProps {
  server: ServerState;
  health: Health | null;
  tournament: TournamentStatus | null;
}

function gamesOf(t: TournamentStatus): number | null {
  for (const k of ['games', 'gamesPlayed', 'played']) {
    const v = t[k];
    if (typeof v === 'number') return v;
  }
  return null;
}

export function Header({ server, health, tournament }: HeaderProps) {
  const botEnabled = health?.bot?.enabled === true;
  const connected = tournament?.connected ?? health?.bot?.connected ?? false;
  const games = tournament ? gamesOf(tournament) : null;
  return (
    <header className="header">
      <div className="header__brand">
        <span className="logo" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <div>
          <h1 className="header__title">Cuatro en Línea 8×7</h1>
          <p className="header__team">Equipo 3</p>
        </div>
      </div>
      <div className="header__badges">
        {server === 'up' && botEnabled && (
          <span className={`badge ${connected ? 'badge--ok' : 'badge--warn'}`} data-testid="tournament-badge">
            Bot del torneo: {connected ? 'conectado' : 'desconectado'}
            {games !== null && ` · partidas ${games}`}
          </span>
        )}
        <span
          className={`badge ${server === 'up' ? 'badge--ok' : server === 'down' ? 'badge--error' : ''}`}
          data-testid="server-badge"
          title={health?.version ? `Versión ${health.version}` : undefined}
        >
          <span className="badge__dot" aria-hidden="true" />
          {server === 'up' ? 'Servidor en línea' : server === 'down' ? 'Servidor desconectado' : 'Conectando…'}
        </span>
      </div>
    </header>
  );
}

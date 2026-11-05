import { LEVELS, type Level, type Starter } from '../logic/game.ts';

interface ControlPanelProps {
  starter: Starter;
  level: Level;
  canUndo: boolean;
  onStarter: (s: Starter) => void;
  onLevel: (l: Level) => void;
  onNewGame: () => void;
  onUndo: () => void;
}

interface Option<T extends string> {
  id: T;
  label: string;
}

function Segmented<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="field">
      <legend className="field__label">{label}</legend>
      <div className="segmented">
        {options.map((o) => (
          <label key={o.id} className={`segmented__item${o.id === value ? ' is-active' : ''}`}>
            <input
              type="radio"
              name={name}
              value={o.id}
              checked={o.id === value}
              onChange={() => onChange(o.id)}
              data-testid={`${name}-${o.id}`}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const STARTERS: ReadonlyArray<Option<Starter>> = [
  { id: 'human', label: 'Tú' },
  { id: 'bot', label: 'Bot' },
];

export function ControlPanel({ starter, level, canUndo, onStarter, onLevel, onNewGame, onUndo }: ControlPanelProps) {
  return (
    <section className="card controls" aria-label="Opciones de la partida">
      <Segmented name="starter" label="¿Quién empieza?" options={STARTERS} value={starter} onChange={onStarter} />
      <Segmented name="level" label="Dificultad" options={LEVELS} value={level} onChange={onLevel} />
      <div className="controls__actions">
        <button type="button" className="btn btn--primary" onClick={onNewGame} data-testid="new-game">
          Nueva partida
        </button>
        <button type="button" className="btn" onClick={onUndo} disabled={!canUndo} data-testid="undo" title="Deshace tu última jugada y la respuesta del bot">
          Deshacer
        </button>
      </div>
    </section>
  );
}

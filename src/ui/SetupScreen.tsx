// S1 match setup (R-SETUP-2, R-SETUP-3). "Left" and "right" are literal: the sides of this screen on the post.
import { useState, type ReactNode } from 'react';
import { DEFAULT_SETUP, PALETTE, type Format, type MatchSetup, type PointReasons, type Points, type Team, type TeamSetup } from '../engine';
import { loadLastSetup } from '../match/prefs';
import { CameraStatus } from './CameraLink';
import { UpdateBanner } from './RoleScreen';

function Seg<T extends string | number | boolean>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<[T, ReactNode]>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

function TeamCard({
  side,
  team,
  setup,
  doubles,
  otherColor,
  onChange,
}: {
  side: 'LEFT' | 'RIGHT';
  team: Team;
  setup: TeamSetup;
  doubles: boolean;
  otherColor: number;
  onChange: (t: TeamSetup) => void;
}) {
  const color = PALETTE[setup.color];
  const pName = (i: 0 | 1) => setup.players[i].trim() || `Player ${i + 1}`;
  return (
    <section className="sheet flex min-w-0 flex-1 flex-col gap-2 p-3" style={{ borderColor: `${color}66` }}>
      <div className="lab">{side} of this screen</div>
      <div className="flex items-center gap-3">
        <input
          className="field max-w-40 font-semibold"
          style={{ color }}
          aria-label={`${side.toLowerCase()} team name`}
          value={setup.name}
          maxLength={14}
          placeholder={`Team ${team}`}
          onChange={(e) => onChange({ ...setup, name: e.target.value })}
        />
        <div className="flex shrink-0 gap-1" role="group" aria-label={`${side.toLowerCase()} team colour`}>
          {PALETTE.map((c, i) => (
            <button
              key={c}
              type="button"
              aria-label={`colour ${i + 1}`}
              aria-pressed={setup.color === i}
              disabled={i === otherColor}
              onClick={() => onChange({ ...setup, color: i })}
              className={`size-7 rounded-full border-[3px] disabled:opacity-20 ${setup.color === i ? 'border-white' : 'border-transparent'}`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      {doubles && (
        <>
          <div className="flex gap-2">
            {([0, 1] as const).map((i) => (
              <input
                key={i}
                className="field"
                aria-label={`${side.toLowerCase()} player ${i + 1}`}
                value={setup.players[i]}
                maxLength={14}
                placeholder={`Player ${i + 1}`}
                onChange={(e) => {
                  const players: [string, string] = [...setup.players];
                  players[i] = e.target.value;
                  onChange({ ...setup, players });
                }}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="lab">Starts in the right court</span>
            <Seg
              label={`${side.toLowerCase()} team right court`}
              value={setup.startRight}
              options={[
                [0, pName(0)],
                [1, pName(1)],
              ]}
              onChange={(v) => onChange({ ...setup, startRight: v })}
            />
          </div>
        </>
      )}
    </section>
  );
}

export function SetupScreen({
  onBack,
  onStart,
  onUpdate,
  onPair,
}: {
  onBack: () => void;
  onStart: (s: MatchSetup) => void;
  onUpdate: (() => void) | null;
  onPair: () => void;
}) {
  const [last] = useState(loadLastSetup);
  const [setup, setSetup] = useState<MatchSetup>(() => last ?? DEFAULT_SETUP);
  const set = <K extends keyof MatchSetup>(k: K, v: MatchSetup[K]) => setSetup((s) => ({ ...s, [k]: v }));
  const setTeam = (t: Team, ts: TeamSetup) => setSetup((s) => ({ ...s, teams: { ...s.teams, [t]: ts } }));

  return (
    <main className="pad-safe-x flex h-full flex-col gap-2 overflow-y-auto pt-2 pb-[max(8px,env(safe-area-inset-bottom))] [touch-action:pan-y]">
      <div className="flex items-center gap-2">
        <button className="btn btn-ghost" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <h1 className="flex-1 text-base font-semibold text-mut">Match setup</h1>
        <CameraStatus onPair={onPair} />
        {last && (
          <button className="btn btn-ghost" onClick={() => onStart(last)}>
            Same as last
          </button>
        )}
        <button className="btn btn-pri px-5" onClick={() => onStart(setup)}>
          START MATCH
        </button>
      </div>
      <UpdateBanner onUpdate={onUpdate} />
      <div className="flex gap-3">
        <TeamCard side="LEFT" team="A" setup={setup.teams.A} doubles={setup.doubles} otherColor={setup.teams.B.color} onChange={(t) => setTeam('A', t)} />
        <TeamCard side="RIGHT" team="B" setup={setup.teams.B} doubles={setup.doubles} otherColor={setup.teams.A.color} onChange={(t) => setTeam('B', t)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Row label="Players">
          <Seg label="players" value={setup.doubles} options={[[false, 'Singles'], [true, 'Doubles']]} onChange={(v) => set('doubles', v)} />
        </Row>
        <Row label="Points">
          <Seg<Points> label="points" value={setup.points} options={[[11, '11'], [15, '15'], [21, '21']]} onChange={(v) => set('points', v)} />
        </Row>
        <Row label="Format">
          <Seg<Format>
            label="format"
            value={setup.format}
            options={[
              ['bestOf3', 'Best of 3'],
              ['fixed2', 'Fixed 2'],
              ['fixed1', 'Fixed 1'],
            ]}
            onChange={(v) => set('format', v)}
          />
        </Row>
        <Row label="Interval at 11">
          <Seg label="interval" value={setup.interval} options={[[true, 'On'], [false, 'Off']]} onChange={(v) => set('interval', v)} />
        </Row>
        <Row label="First server">
          <Seg<Team>
            label="first server"
            value={setup.firstServer}
            options={[
              ['A', 'Left team'],
              ['B', 'Right team'],
            ]}
            onChange={(v) => set('firstServer', v)}
          />
        </Row>
        <Row label="Point reasons">
          <Seg<PointReasons>
            label="point reasons"
            value={setup.reasons}
            options={[
              ['off', 'Off'],
              ['endOfGame', 'End of game'],
            ]}
            onChange={(v) => set('reasons', v)}
          />
        </Row>
      </div>
      <p className="text-xs leading-relaxed text-mut">
        {setup.format === 'fixed2' && 'Fixed 2: two games always, 1-1 is a draw. '}
        {setup.doubles &&
          'Doubles: the right-court player of the serving team serves first; the right-court player of the other team receives. '}
        {setup.reasons === 'off'
          ? 'Point reasons off: scoring only. '
          : 'Point reasons: after each point, tap who hit the last shot (optional); the stats show at the end of each game. '}
        Tap your half to score, swipe down or tap Undo to take it back, long-press a half to correct. Tip: iOS Guided
        Access (Settings, Accessibility) locks the phone to this app for a match.
      </p>
    </main>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="lab">{label}</span>
      {children}
    </span>
  );
}

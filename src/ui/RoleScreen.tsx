// S0 role choice (R-SETUP-1) and the phase-1 stand-in for the camera role.
import { useState } from 'react';
import { checkSupport } from '../device/support';
import type { Role } from '../match/prefs';

export function UpdateBanner({ onUpdate }: { onUpdate: (() => void) | null }) {
  if (!onUpdate) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-pan px-3 py-2 text-sm">
      <span className="flex-1">A new version of the app is ready.</span>
      <button className="btn btn-pri" onClick={onUpdate}>
        Update now
      </button>
    </div>
  );
}

export function RoleScreen({
  lastRole,
  onPick,
  onUpdate,
}: {
  lastRole: Role | null;
  onPick: (r: Role) => void;
  onUpdate: (() => void) | null;
}) {
  const [support] = useState(() => checkSupport());
  const roles: Array<{ role: Role; title: string; sub: string }> = [
    { role: 'scoreboard', title: 'SCOREBOARD', sub: 'at the net post' },
    { role: 'camera', title: 'CAMERA', sub: 'at the back corner' },
  ];
  const highlight = lastRole ?? 'scoreboard';
  return (
    <main className="pad-safe-x flex h-full flex-col gap-3 overflow-y-auto py-3">
      <h1 className="text-center text-lg font-semibold text-mut">Badminton scoreboard</h1>
      <UpdateBanner onUpdate={onUpdate} />
      <div className="flex min-h-40 flex-1 gap-4">
        {roles.map((r) => (
          <button
            key={r.role}
            onClick={() => onPick(r.role)}
            className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl border-2 ${
              highlight === r.role ? 'border-pri bg-pri/15' : 'border-line bg-pan'
            }`}
          >
            <span className="text-3xl font-extrabold tracking-wide">{r.title}</span>
            <span className="text-mut">{r.sub}</span>
            {r.role === 'camera' && <span className="mt-1 text-xs text-amber">recording arrives in the next version</span>}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-mut">
        <span>Last time: {lastRole === 'camera' ? 'Camera' : lastRole === 'scoreboard' ? 'Scoreboard' : '-'}</span>
        {support.message && <span className="text-amber">{support.message}</span>}
        {support.ios && !support.standalone && (
          <span>Tip: Share, then "Add to Home Screen" so it runs offline and keeps the screen on.</span>
        )}
      </div>
    </main>
  );
}

export function CameraPlaceholder({ onBack, onScoreboard }: { onBack: () => void; onScoreboard: () => void }) {
  return (
    <main className="pad-safe-x flex h-full flex-col items-center justify-center gap-4 py-4 text-center">
      <h1 className="text-2xl font-bold">Camera</h1>
      <p className="max-w-xl text-mut">
        Recording the match with the score in the video, and pairing with the scoreboard phone, come in the next
        version. For now this app is the scoreboard.
      </p>
      <div className="flex gap-3">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button className="btn btn-pri" onClick={onScoreboard}>
          Use as scoreboard
        </button>
      </div>
    </main>
  );
}

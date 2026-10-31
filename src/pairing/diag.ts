// The pairing log each phone keeps for itself (⋯ › Pairing diagnostics): build, every helper request with its
// status, the relay credentials and ICE servers (no secrets), the candidates each side offered by type, ICE
// and channel state changes, the candidate pair carrying the link (direct or relay), the network check and the
// last error, with a one-line summary to read out. In memory and localStorage only: nothing leaves the phone
// unless the user copies or shares it. Times are UTC, like the helper's request logs on Vercel.
import { APP_BUILD } from '../build';
import type { Role } from '../protocol/messages';

export type DiagKind = 'app' | 'helper' | 'sdp' | 'ice' | 'link' | 'net' | 'relay' | 'path' | 'error';

export interface DiagEntry {
  at: number;
  kind: DiagKind;
  text: string;
  /** The same line again: how many times, and when last. */
  n?: number;
  last?: number;
}

export interface DiagSnapshot {
  entries: readonly DiagEntry[];
  /** The newest line of each kind, for the summary. */
  latest: Partial<Record<DiagKind, string>>;
}

export const DIAG_MAX = 300;
const SAVE_AFTER_MS = 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Set by the app when a newer build is installed and waiting for "Update the app". */
let updateWaiting = false;
export function setUpdateWaiting(v: boolean): void {
  updateWaiting = v;
}

export const utc = (t: number) => new Date(t).toISOString().slice(11, 23);

export class PairingDiag {
  private snap: DiagSnapshot = { entries: [], latest: {} };
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly key: string;

  constructor(
    readonly role: Role,
    private readonly storage: Store | null = browserStorage(),
    private readonly now: () => number = Date.now,
  ) {
    this.key = `bs.diag.${role}`;
    try {
      const saved = JSON.parse(this.storage?.getItem(this.key) ?? 'null') as DiagSnapshot | null;
      if (saved && Array.isArray(saved.entries)) this.snap = { entries: saved.entries.slice(-DIAG_MAX), latest: saved.latest ?? {} };
    } catch {
      // unreadable: start a new log
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): DiagSnapshot => this.snap;

  log(kind: DiagKind, text: string): void {
    const at = this.now();
    const entries = [...this.snap.entries];
    const prev = entries.at(-1);
    if (prev && prev.kind === kind && prev.text === text) entries[entries.length - 1] = { ...prev, n: (prev.n ?? 1) + 1, last: at };
    else entries.push({ at, kind, text });
    this.snap = { entries: entries.slice(-DIAG_MAX), latest: { ...this.snap.latest, [kind]: text } };
    this.changed();
  }

  clear(): void {
    this.snap = { entries: [], latest: {} };
    this.changed();
  }

  /** Write a pending save now (tests; the page going away). */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      if (this.snap.entries.length) this.storage?.setItem(this.key, JSON.stringify(this.snap));
      else this.storage?.removeItem(this.key);
    } catch {
      // storage full or private mode: the log still lives in memory
    }
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
    this.saveTimer ??= setTimeout(() => this.flush(), SAVE_AFTER_MS);
  }

  /**
   * One line to read out: role, build, the link's path (direct, relay or none), the relay, network check, ICE,
   * last error (with its time: it may be old).
   */
  summary(): string {
    const l = this.snap.latest;
    const err = this.snap.entries.findLast((e) => e.kind === 'error');
    return [
      this.role,
      `build ${buildStamp()}${updateWaiting ? ' (update waiting)' : ''}`,
      `path ${l.path ? l.path.split(':')[0] : 'none'}`,
      l.relay ? `relay: ${l.relay.split(' · ')[0]}` : 'relay: not checked',
      l.net ? `net ${l.net}` : 'net not checked',
      l.ice ?? 'ice not started',
      l.error ? `error ${l.error}${err ? ` at ${utc(err.last ?? err.at).slice(0, 8)}` : ''}` : 'no error',
    ].join(' · ');
  }

  /** The whole log as text, for Copy and Share. */
  report(env: Record<string, string> = environment()): string {
    const lines = [
      'Badminton scoreboard: pairing diagnostics',
      `summary: ${this.summary()}`,
      `role: ${this.role}`,
      `build: ${APP_BUILD}${updateWaiting ? ' (a newer build is waiting: Update the app)' : ''}`,
      ...Object.entries(env).map(([k, v]) => `${k}: ${v}`),
      `now: ${new Date(this.now()).toISOString()}`,
      '--- log, oldest first, times UTC ---',
      ...this.snap.entries.map(entryLine),
    ];
    return lines.join('\n');
  }
}

export function entryLine(e: DiagEntry): string {
  const again = e.n ? ` (×${e.n}, last ${utc(e.last ?? e.at)})` : '';
  return `${utc(e.at)} ${e.kind.padEnd(6)} ${e.text}${again}`;
}

/** "2026-10-28T13:00" out of "badminton-scoreboard@0.3.0+2026-10-28T13:00": when it was built, UTC. */
export function buildStamp(build = APP_BUILD): string {
  return build.split('+')[1] ?? build;
}

function environment(): Record<string, string> {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const standalone =
    (nav as { standalone?: boolean } | null)?.standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
  const conn = (nav as { connection?: { type?: string; effectiveType?: string } } | null)?.connection;
  return {
    device: nav?.userAgent ?? 'unknown',
    app: standalone ? 'home screen app' : 'browser tab',
    online: nav ? (nav.onLine ? 'yes' : 'no') : 'unknown',
    // Safari does not say whether it is on Wi-Fi or mobile data; the candidates and the network check do.
    network: conn?.type ?? conn?.effectiveType ?? 'not reported by this browser',
    'service worker': nav?.serviceWorker?.controller ? 'controls this page' : 'none',
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** `/sessions/ff8a33…/answer?gen=1` out of a helper URL: a short session id, never the secret (a header). */
export function helperPath(url: string): string {
  return url
    .replace(/^.*\/api\/signal/, '')
    .replace(/(\/sessions\/[0-9a-f]{6})[0-9a-f]{26}/, '$1…')
    .replace(/\?claim=[0-9a-f]+$/, ''); // the claim id (BUG-5) says nothing to a reader
}

/** A fetch for HelperClient that logs each request: method, path, status (and the helper's error code). */
export function loggedFetch(diag: PairingDiag, fetchImpl: Fetch = (i, init) => fetch(i, init)): Fetch {
  return async (url, init) => {
    const start = Date.now();
    const what = `${init?.method ?? 'GET'} ${helperPath(url)}`;
    const slow = () => {
      const ms = Date.now() - start;
      return ms >= 1500 ? ` slow ${ms} ms` : '';
    };
    try {
      const res = await fetchImpl(url, init);
      let code = '';
      if (res.status >= 400) code = (await res.clone().json().then((j: { error?: string }) => j?.error, () => '')) ?? '';
      diag.log('helper', `${what} → ${res.status}${code ? ` ${code}` : ''}${slow()}`);
      return res;
    } catch (err) {
      diag.log('helper', `${what} → no answer (${(err as Error)?.name ?? 'error'})${slow()}`);
      throw err;
    }
  };
}

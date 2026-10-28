// The live match in IndexedDB, written after every event so a reload, crash or battery swap loses nothing
// (technical-design.md §3.5, R-SCORE-9).
import type { MatchConfig, MatchEvent } from '../engine';

export interface StoredMatch {
  matchId: string;
  config: MatchConfig;
  events: MatchEvent[];
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'badminton-scoreboard';
const DB_VERSION = 1;
const MATCHES = 'matches';
const META = 'meta';
const CURRENT = 'current';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MATCHES)) db.createObjectStore(MATCHES, { keyPath: 'matchId' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Store the match and mark it as the current one, in one transaction. */
export async function saveMatch(m: StoredMatch): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MATCHES, META], 'readwrite');
  tx.objectStore(MATCHES).put(m);
  tx.objectStore(META).put(m.matchId, CURRENT);
  await done(tx);
}

export async function loadCurrent(): Promise<StoredMatch | null> {
  const db = await openDb();
  const tx = db.transaction([MATCHES, META], 'readonly');
  const id = await result(tx.objectStore(META).get(CURRENT) as IDBRequest<string | undefined>);
  if (!id) return null;
  const m = await result(tx.objectStore(MATCHES).get(id) as IDBRequest<StoredMatch | undefined>);
  return m ?? null;
}

/** Forget which match is current (the match itself stays stored). */
export async function clearCurrent(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  tx.objectStore(META).delete(CURRENT);
  await done(tx);
}

const LOGO = 'camera.logo';

/** The camera's optional overlay logo (an image Blob), kept on this device next to the live match. */
export async function saveLogo(blob: Blob | null): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  if (blob) tx.objectStore(META).put(blob, LOGO);
  else tx.objectStore(META).delete(LOGO);
  await done(tx);
}

export async function loadLogo(): Promise<Blob | null> {
  const db = await openDb();
  const tx = db.transaction(META, 'readonly');
  const b = await result(tx.objectStore(META).get(LOGO) as IDBRequest<Blob | undefined>);
  return b ?? null;
}

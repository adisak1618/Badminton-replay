// Reading the camera's OPFS records on the main thread (lists, export, delete) and the storage figures
// (R-REC-3, R-REC-6, R-EXP-3, N-STORE-1). Writes go through the recording worker.
import type { PeerInfo } from '../link/source';
import { LOG_FILE, MATCHES_DIR, RECORDING_FILE, repairMeta, type MirrorLog, type RecordingMeta, type StoredFile } from './meta';

export interface StoredRecording {
  meta: RecordingMeta;
  log: MirrorLog | null;
  files: Map<string, File>;
}

export const opfsSupported = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';

async function matchesDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(MATCHES_DIR, { create });
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError') return null;
    throw err;
  }
}

type IterableDir = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

async function readJson<T>(files: Map<string, File>, name: string): Promise<T | null> {
  const f = files.get(name);
  if (!f) return null;
  try {
    return JSON.parse(await f.text()) as T;
  } catch {
    return null; // cut short by a crash mid-write: repairMeta rebuilds from the video files
  }
}

export async function readRecording(dir: FileSystemDirectoryHandle, camera: PeerInfo): Promise<StoredRecording> {
  const files = new Map<string, File>();
  for await (const h of (dir as IterableDir).values()) {
    if (h.kind === 'file') files.set(h.name, await (h as FileSystemFileHandle).getFile());
  }
  const stored: StoredFile[] = [...files.values()].map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified }));
  const meta = repairMeta(await readJson<RecordingMeta>(files, RECORDING_FILE), dir.name, stored, camera);
  return { meta, log: await readJson<MirrorLog>(files, LOG_FILE), files };
}

/** Every recorded match, newest first. */
export async function listRecordings(camera: PeerInfo): Promise<StoredRecording[]> {
  if (!opfsSupported()) return [];
  const dir = await matchesDir(false);
  if (!dir) return [];
  const out: StoredRecording[] = [];
  for await (const h of (dir as IterableDir).values()) {
    if (h.kind !== 'directory') continue;
    const r = await readRecording(h as FileSystemDirectoryHandle, camera);
    if (r.meta.segments.length) out.push(r);
  }
  return out.sort((a, b) => b.meta.createdAt - a.meta.createdAt);
}

export async function countRecordings(): Promise<number> {
  if (!opfsSupported()) return 0;
  try {
    const dir = await matchesDir(false);
    if (!dir) return 0;
    let n = 0;
    for await (const h of (dir as IterableDir).values()) if (h.kind === 'directory') n++;
    return n;
  } catch {
    return 0;
  }
}

/** The stored record of one match, if it was recorded before (a second REC continues its segments). */
export async function findRecording(id: string, camera: PeerInfo): Promise<StoredRecording | null> {
  const dir = await matchesDir(false);
  if (!dir) return null;
  try {
    return await readRecording(await dir.getDirectoryHandle(id), camera);
  } catch {
    return null;
  }
}

export async function deleteRecording(id: string): Promise<void> {
  const dir = await matchesDir(false);
  await dir?.removeEntry(id, { recursive: true });
}

export interface StorageFigures {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export async function storageFigures(): Promise<StorageFigures> {
  const s = navigator.storage;
  const est = await s?.estimate?.().catch(() => null);
  const persisted = await s?.persisted?.().catch(() => null);
  return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted: persisted ?? null };
}

/** N-STORE-1: ask once; WebKit grants it by heuristics such as an installed Home Screen app. */
export async function requestPersistence(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persist?.()) ?? null;
  } catch {
    return null;
  }
}

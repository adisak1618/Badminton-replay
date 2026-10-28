// Dedicated recording worker: OPFS through sync access handles (technical-design.md §6.4).
/// <reference lib="webworker" />
import { OpfsWriter, type WriterRequest } from './writer';

async function openHandle(dir: string[], file: string) {
  let d = await navigator.storage.getDirectory();
  for (const name of dir) d = await d.getDirectoryHandle(name, { create: true });
  const fh = await d.getFileHandle(file, { create: true });
  return fh.createSyncAccessHandle();
}

const writer = new OpfsWriter(openHandle);
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<WriterRequest>) => {
  scope.postMessage(await writer.handle(e.data));
};

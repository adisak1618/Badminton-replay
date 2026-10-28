// Not paired: no match arrives, so the overlay is not drawn (R-REC-4) and the chip stays red. Recording
// still works (D2: no internet on the court means a clean video without the overlay).
import type { ScoreSource } from './source';

export class NoSource implements ScoreSource {
  readonly kind = 'none' as const;
  connect(l: Parameters<ScoreSource['connect']>[0]): () => void {
    l.link('unpaired');
    return () => {};
  }
  link() {
    return 'unpaired' as const;
  }
  clock() {
    return null;
  }
  peer() {
    return null;
  }
  report(): void {}
  ack(): void {}
}

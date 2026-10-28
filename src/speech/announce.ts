// Sound and voice for one change of the match, honouring the menu toggles.
import type { Change } from '../match/store';
import type { Prefs } from '../match/prefs';
import { feedbackFor } from './phrases';
import { playChime } from './sound';
import { speak } from './speech';

export function announce(change: Change | null, prefs: Prefs): void {
  if (!change) return;
  const fb = feedbackFor(change.config, change.prev, change.next, change.event, prefs.lang);
  if (prefs.sound && fb.chime) playChime(fb.chime);
  if (prefs.voice && fb.speech) speak(fb.speech, prefs.lang);
}

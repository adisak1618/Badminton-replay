// speechSynthesis wrapper (technical-design.md §5): each utterance cancels the previous one so a fast rally
// never queues stale scores.
import type { Lang } from './phrases';

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis);

export const speechAvailable = (): boolean => synth() !== null;

function voiceFor(lang: Lang): SpeechSynthesisVoice | null {
  const voices = synth()?.getVoices() ?? [];
  const want = lang === 'th' ? 'th' : 'en';
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(want));
  return matching.find((v) => v.localService) ?? matching[0] ?? null;
}

/** Whether a voice for the language is installed; unknown (true) until the voice list has loaded. */
export function hasVoice(lang: Lang): boolean {
  const s = synth();
  if (!s) return false;
  return s.getVoices().length === 0 || voiceFor(lang) !== null;
}

export function speak(text: string, lang: Lang): void {
  const s = synth();
  if (!s) return;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'th' ? 'th-TH' : 'en-GB';
  const v = voiceFor(lang);
  if (v) u.voice = v;
  u.rate = 1;
  u.volume = 1;
  s.speak(u);
}

export function stopSpeaking(): void {
  synth()?.cancel();
}

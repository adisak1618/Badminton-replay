// Keyboard shortcuts while scoring a saved video on a computer (D17, R-VID-4; ux-design.md S3v). Pure: a key press
// to an action. The board does the scoring ones exactly as a tap would; the player does the rest.

export type VideoAction = 'play' | 'back5' | 'fwd5' | 'back1' | 'fwd1' | 'slow' | 'normal' | 'fast' | 'mute' | 'help';
export type BoardAction = 'left' | 'right' | 'undo' | 'redo' | 'replay' | 'tag' | 'ends';
export type KeyAction = VideoAction | BoardAction;

const VIDEO = new Set<KeyAction>(['play', 'back5', 'fwd5', 'back1', 'fwd1', 'slow', 'normal', 'fast', 'mute', 'help']);
export const isVideoAction = (a: KeyAction): a is VideoAction => VIDEO.has(a);

/** Playback speeds offered (0.5× / 1× / 2×), and the action that picks each. */
export const SPEEDS = [0.5, 1, 2] as const;
export type Speed = (typeof SPEEDS)[number];
export const SPEED_OF: Record<'slow' | 'normal' | 'fast', Speed> = { slow: 0.5, normal: 1, fast: 2 };

/** Seconds each seek action moves. */
export const SEEK_S: Partial<Record<VideoAction, number>> = { back5: -5, fwd5: 5, back1: -1, fwd1: 1 };

export interface KeyPress {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The action of a key press, or null for keys this mode leaves alone (anything with ⌘, Ctrl or ⌥ held). */
export function keyAction(e: KeyPress): KeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case ' ':
      return 'play';
    case 'ArrowLeft':
      return e.shiftKey ? 'back1' : 'back5';
    case 'ArrowRight':
      return e.shiftKey ? 'fwd1' : 'fwd5';
    case '?':
      return 'help';
    case '1':
      return 'slow';
    case '2':
      return 'normal';
    case '3':
      return 'fast';
  }
  switch (e.key.toLowerCase()) {
    case 'k':
      return 'play';
    case 'm':
      return 'mute';
    case 'a':
      return 'left';
    case 'b':
    case 'l':
      return 'right';
    case 'u':
      return e.shiftKey ? 'redo' : 'undo';
    case 'r':
      return 'replay';
    case 't':
      return 'tag';
    case 'e':
      return 'ends';
  }
  return null;
}

/** The shortcut list shown on screen (keys, what they do), in the order of ux-design.md S3v. */
export const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['Space or K', 'play / pause'],
  ['← / →', 'back / forward 5 s'],
  ['Shift + ← / →', 'back / forward 1 s'],
  ['1 / 2 / 3', 'speed 0.5× / 1× / 2×'],
  ['M', 'sound on / off'],
  ['A', 'point to the team on the left of the screen'],
  ['B or L', 'point to the team on the right of the screen'],
  ['U / Shift + U', 'undo / redo'],
  ['R', '☆ replay mark on the last point'],
  ['T', 'why-was-this-point-won popup for the last point'],
  ['E', 'swap ends'],
  ['?', 'this list'],
];

/** A key typed into a text field is the field's, never a shortcut. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type ?? 'text').toLowerCase();
    return !['range', 'button', 'checkbox', 'radio', 'file', 'submit', 'reset'].includes(type);
  }
  return el.isContentEditable === true;
}

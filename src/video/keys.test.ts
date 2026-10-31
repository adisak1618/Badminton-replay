import { describe, expect, it } from 'vitest';
import { SHORTCUTS, isVideoAction, keyAction, typingIn, type KeyPress } from './keys';

const k = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });

describe('keyboard shortcuts when scoring a video (D17, R-VID-4)', () => {
  it('maps the player keys', () => {
    expect(keyAction(k(' '))).toBe('play');
    expect(keyAction(k('k'))).toBe('play');
    expect(keyAction(k('ArrowLeft'))).toBe('back5');
    expect(keyAction(k('ArrowRight'))).toBe('fwd5');
    expect(keyAction(k('ArrowLeft', { shiftKey: true }))).toBe('back1');
    expect(keyAction(k('ArrowRight', { shiftKey: true }))).toBe('fwd1');
    expect(['1', '2', '3'].map((d) => keyAction(k(d)))).toEqual(['slow', 'normal', 'fast']);
    expect(keyAction(k('m'))).toBe('mute');
    expect(keyAction(k('?', { shiftKey: true }))).toBe('help');
  });

  it('maps the score keys to the sides as displayed, either case', () => {
    expect(keyAction(k('a'))).toBe('left');
    expect(keyAction(k('A', { shiftKey: true }))).toBe('left');
    expect(keyAction(k('b'))).toBe('right');
    expect(keyAction(k('l'))).toBe('right');
    expect(keyAction(k('u'))).toBe('undo');
    expect(keyAction(k('U', { shiftKey: true }))).toBe('redo');
    expect(keyAction(k('r'))).toBe('replay');
    expect(keyAction(k('t'))).toBe('tag');
    expect(keyAction(k('e'))).toBe('ends');
  });

  it('leaves alone keys with ⌘, Ctrl or ⌥ and keys it does not know', () => {
    expect(keyAction(k('r', { metaKey: true }))).toBeNull(); // ⌘R reloads
    expect(keyAction(k('a', { ctrlKey: true }))).toBeNull();
    expect(keyAction(k('ArrowLeft', { altKey: true }))).toBeNull();
    expect(keyAction(k('x'))).toBeNull();
    expect(keyAction(k('Escape'))).toBeNull();
  });

  it('splits player actions from board actions', () => {
    expect(isVideoAction('play')).toBe(true);
    expect(isVideoAction('fwd1')).toBe(true);
    expect(isVideoAction('left')).toBe(false);
    expect(isVideoAction('undo')).toBe(false);
  });

  it('a key typed into a text field is the field’s', () => {
    expect(typingIn({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true);
    expect(typingIn({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(typingIn({ tagName: 'INPUT', type: 'range' } as unknown as EventTarget)).toBe(false);
    expect(typingIn({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(typingIn({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(typingIn(null)).toBe(false);
  });

  it('lists every key it answers to', () => {
    const listed = SHORTCUTS.map(([keys]) => keys).join(' ');
    for (const key of ['Space', 'K', '←', 'Shift', '1 / 2 / 3', 'M', 'A', 'B or L', 'U', 'R', 'T', 'E', '?']) expect(listed).toContain(key);
  });
});

/** Shared by main (registration) and the renderer (Settings › Hotkeys, the "press … and say it" hints). */
const SYMBOL: Record<string, string> = { Control: '⌃', Alt: '⌥', Option: '⌥', Command: '⌘', CommandOrControl: '⌘', Shift: '⇧' };

/** "Control+Alt+Space" → "⌃⌥Space". */
export function displayOf(accelerator: string): string {
  return accelerator
    .split('+')
    .map((p) => SYMBOL[p] ?? p)
    .join('');
}

/**
 * Browser-permission policy for every window. The renderer records the voice note itself
 * (getUserMedia → 16 kHz PCM16 → voice.chunk), so the app's own pages may open the
 * MICROPHONE and nothing else: no camera, no screen capture, no geolocation, no notifications.
 * Pure functions — Electron calls them from session.setPermission{Request,Check}Handler.
 */
export interface PermissionContext {
  /** Origin or URL asking. */
  requestingUrl: string;
  /** `details.mediaTypes` (request handler) or `[details.mediaType]` (check handler). */
  mediaTypes: readonly string[];
  /** The dev server URL, when running `npm run dev:electron`. */
  devUrl?: string;
}

export function isAppUrl(url: string, devUrl?: string): boolean {
  if (!url) return false;
  if (devUrl) {
    try {
      return new URL(url).origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return url.startsWith('file://');
}

export function allowPermission(permission: string, ctx: PermissionContext): boolean {
  if (permission !== 'media') return false;
  if (!isAppUrl(ctx.requestingUrl, ctx.devUrl)) return false;
  // Fails closed: at least one track, and every track audio.
  return ctx.mediaTypes.length > 0 && ctx.mediaTypes.every((t) => t === 'audio');
}

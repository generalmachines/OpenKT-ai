import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { models as modelsIpc, screenshot as screenshotIpc, voice as voiceIpc } from '../api/bridge';
import { useClient } from '../api/hooks';
import { CAPTURE_SIGNAL, drainPending } from '../capture/save';
import { ScreenshotCapture } from '../screens/capture/ScreenshotCapture';
import { Palette, type PaletteScope } from './Palette';
import { Sidebar } from './Sidebar';

const SearchContext = createContext<(scope?: PaletteScope) => void>(() => {});

/** Open the ⌘K palette, optionally scoped to a space. */
export function useSearch() {
  return useContext(SearchContext);
}

export function Shell() {
  const [palette, setPalette] = useState<{ scope: PaletteScope | null } | null>(null);
  const openSearch = useCallback((scope?: PaletteScope) => setPalette({ scope: scope ?? null }), []);
  const navigate = useNavigate();
  const client = useClient();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => (p ? null : { scope: null }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Electron only: the tray can navigate this window, and finished captures
  // become sessions here so they show up in the sidebar straight away.
  useEffect(() => {
    const bridge = window.openkt;
    if (!bridge) return;
    const offNav = bridge.app.onNavigate((route) => navigate(route));
    const offCapture = bridge.capture.onEvent((e) => {
      // The simulated engine only ever writes into sample data. With the real capture IPC the overlays file their own sessions.
      if (client.kind !== 'mock') return;
      if (e.type === 'voice.final' && voiceIpc.available()) return;
      if (e.type === 'screenshot.captured' && screenshotIpc.available()) return;
      if (e.type === 'voice.final' && e.text.trim()) {
        const title = e.text.split(/[.—,]/)[0]?.trim().slice(0, 60) || 'Voice note';
        void client.createSession({ source: 'voice', title, spaceId: 'sp-ideas', text: e.text });
      } else if (e.type === 'screenshot.captured') {
        void client.createSession({ source: 'screenshot', title: e.description.split(' — ')[0] ?? 'Screenshot', spaceId: 'sp-northgate', text: e.description });
      } else if (e.type === 'meeting.stopped') {
        void client.createSession({ source: 'meeting', title: e.title, spaceId: 'sp-northgate' });
      }
    });
    return () => {
      offNav();
      offCapture();
    };
  }, [client, navigate]);

  // A capture filed from an overlay window: re-read so it shows up in the sidebar.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === CAPTURE_SIGNAL && client.refresh();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [client]);

  // Sessions saved while the models were still downloading get their context once the models are ready.
  useEffect(() => {
    const tick = () => void drainPending(client);
    tick();
    const timer = setInterval(tick, 30_000);
    const off = modelsIpc.onProgress((m) => m.state === 'ready' && tick());
    return () => {
      clearInterval(timer);
      off();
    };
  }, [client]);

  // Drop an image file anywhere on the window → the screenshot sheet, reading the file instead of the screen.
  const [dropArmed, setDropArmed] = useState(false);
  const [dropped, setDropped] = useState<string | null>(null);
  useEffect(() => {
    if (!screenshotIpc.available()) return;
    const hasFile = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const over = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      setDropArmed(true);
    };
    const leave = (e: DragEvent) => e.relatedTarget === null && setDropArmed(false);
    const drop = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      setDropArmed(false);
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'));
      const path = file ? screenshotIpc.pathForFile(file) : '';
      if (path) setDropped(path);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const ctx = useMemo(() => openSearch, [openSearch]);

  return (
    <SearchContext.Provider value={ctx}>
      <div className="app">
        <Sidebar onSearch={() => openSearch()} />
        <Outlet />
        {palette && <Palette scope={palette.scope} onClose={() => setPalette(null)} />}
        {dropArmed && <div className="dropzone dropzone--armed">Drop the image to save what it says</div>}
        {dropped && (
          <div className="dropzone">
            <ScreenshotCapture key={dropped} request={{ mode: 'file', path: dropped }} onClose={() => setDropped(null)} />
          </div>
        )}
      </div>
    </SearchContext.Provider>
  );
}

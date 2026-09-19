import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useClient } from '../api/hooks';
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

  const ctx = useMemo(() => openSearch, [openSearch]);

  return (
    <SearchContext.Provider value={ctx}>
      <div className="app">
        <Sidebar onSearch={() => openSearch()} />
        <Outlet />
        {palette && <Palette scope={palette.scope} onClose={() => setPalette(null)} />}
      </div>
    </SearchContext.Provider>
  );
}

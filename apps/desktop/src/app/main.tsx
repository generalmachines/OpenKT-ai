import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { loadApiSettings } from '../api';
import { ConnectionProvider } from '../state/connection';
import { AppRoutes } from './AppRoutes';

// Electron on macOS draws traffic lights over the sidebar (hiddenInset).
if (window.openkt) document.documentElement.dataset['platform'] = window.openkt.platform;

// The token may live in the OS keychain, so settings load before the first render.
void loadApiSettings().then((initial) =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ConnectionProvider initial={initial}>
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </ConnectionProvider>
    </StrictMode>,
  ),
);

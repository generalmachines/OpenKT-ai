import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { createClient } from '../api';
import { ApiProvider } from '../api/hooks';
import { AppRoutes } from './AppRoutes';

const client = createClient();

// Electron on macOS draws traffic lights over the sidebar (hiddenInset).
if (window.openkt) document.documentElement.dataset['platform'] = window.openkt.platform;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider client={client}>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </ApiProvider>
  </StrictMode>,
);

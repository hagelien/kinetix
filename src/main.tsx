import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppRouter } from './router';
import { installChunkReloadHandler } from './lib/chunkReload';
import { i18nReady } from './i18n';
import './index.css';

// Reload once when a stale content-hashed chunk fails to load after a deploy.
installChunkReloadHandler();

// Render once the active language's strings are in (see src/i18n.ts), so an
// English visitor never sees a Norwegian first paint.
void i18nReady.finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </React.StrictMode>
  );
});

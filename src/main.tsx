import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppRouter } from './router';
import { installChunkReloadHandler } from './lib/chunkReload';
import './i18n';
import './index.css';

// Reload once when a stale content-hashed chunk fails to load after a deploy.
installChunkReloadHandler();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppRouter />
    </BrowserRouter>
  </React.StrictMode>
);

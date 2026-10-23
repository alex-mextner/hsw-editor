import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installGlobalErrorLogging } from './api/clientErrors.ts';
import { watchAssetNotices } from './bank/assetNotices.ts';
import { refreshBank, startBankAutoRefresh } from './bank/client.ts';
import { refreshToolLibrary } from './features/tools/store.ts';
import { AppErrorBoundary } from './shell/AppErrorBoundary.tsx';
import './pwa/instance.ts';
import './state/theme.ts';
import { initSession } from './wall/session.ts';
import './styles.css';

installGlobalErrorLogging();
initSession();
void refreshBank();
// The tool library is needed by palette commands (`tools.add`) before the Tools tab is ever opened.
void refreshToolLibrary();
startBankAutoRefresh();
watchAssetNotices();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');
createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.tsx';
import { installGlobalErrorLogging } from './api/clientErrors.ts';
import { watchAssetNotices } from './bank/assetNotices.ts';
import { refreshBank, startBankAutoRefresh } from './bank/client.ts';
import { AppErrorBoundary } from './shell/AppErrorBoundary.tsx';
import './state/theme.ts';
import { initSession } from './wall/session.ts';
import './styles.css';

installGlobalErrorLogging();
registerSW({ immediate: true });
initSession();
void refreshBank();
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

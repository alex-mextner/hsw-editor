import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.tsx';
import { loadBank } from './bank/client.ts';
import './state/theme.ts';
import { initSession } from './wall/session.ts';
import './styles.css';

registerSW({ immediate: true });
initSession();
void loadBank();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { loadBank } from './bank/client.ts';
import './pwa/instance.ts';
import './state/theme.ts';
import { initSession } from './wall/session.ts';
import './styles.css';

initSession();
void loadBank();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

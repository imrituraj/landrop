import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppController } from './core/controller.ts';
import { App } from './ui/App.tsx';
import './index.css';

// One controller per page load, created outside React so StrictMode double
// renders/effects can never create duplicate connections.
const app = new AppController();
void app.start();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);

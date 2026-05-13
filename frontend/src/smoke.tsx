import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './App.css';
import { installBrowserMocks } from './test/browserMocks';
import { SmokeScenario } from './test/smokeScenarios';

installBrowserMocks({ immediateIntersectionCallbacks: true });

document.body.dataset.smoke = 'true';
const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'settings';
const container = document.getElementById('root');

if (!container) {
  throw new Error('smoke root not found');
}

createRoot(container).render(
  <React.StrictMode>
    <SmokeScenario scenario={scenario} />
  </React.StrictMode>,
);

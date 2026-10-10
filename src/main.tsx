import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Diagnostic switch: ?noblur=1 turns off every backdrop-filter, to test whether the page's
// many glass panels are behind a rendering flicker without changing the design for anyone else.
if (new URLSearchParams(window.location.search).has('noblur')) {
  document.documentElement.classList.add('noblur');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Self-hosted fonts: the demo never calls out to a font CDN.
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
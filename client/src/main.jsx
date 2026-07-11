import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { startBackground } from './bg.js';
import './styles.css';

startBackground();
createRoot(document.getElementById('root')).render(<App />);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { }));
}

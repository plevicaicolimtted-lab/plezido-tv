import { createRoot } from 'react-dom/client';
import '../index.css';
import ViewerApp from './ViewerApp';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}

createRoot(document.getElementById('viewer-root')!).render(<ViewerApp />);

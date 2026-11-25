import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { FirebaseProvider } from '../contexts/FirebaseContext';
import '../index.css';
import ViewerApp from './ViewerApp';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}

createRoot(document.getElementById('viewer-root')!).render(
  <ErrorBoundary>
    <FirebaseProvider>
      <ViewerApp />
    </FirebaseProvider>
  </ErrorBoundary>
);

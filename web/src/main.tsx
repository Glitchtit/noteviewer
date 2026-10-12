import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PrintView } from './components/PrintView';
import { SharedView } from './components/SharedView';
import 'katex/dist/katex.min.css';
import './theme.css';

function Root() {
  const { pathname, search } = window.location;
  const shared = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (shared) return <SharedView token={shared[1]!} />;
  if (pathname === '/print') return <PrintView path={new URLSearchParams(search).get('path') ?? ''} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(<Root />);

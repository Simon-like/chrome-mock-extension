import { createRoot } from 'react-dom/client';
import '@ui/styles.css';
import { PanelApp } from './PanelApp.js';

createRoot(document.getElementById('root')!).render(<PanelApp />);

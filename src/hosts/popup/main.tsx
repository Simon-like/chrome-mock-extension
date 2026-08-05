import { createRoot } from 'react-dom/client';
import '@ui/styles.css';
import { Popup } from './Popup.js';

createRoot(document.getElementById('root')!).render(<Popup />);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App, CharacterWindowApp } from '@kurisu/ui';

const isCharacterWindow = new URLSearchParams(window.location.search).get('window') === 'character';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCharacterWindow ? <CharacterWindowApp /> : <App />}
  </React.StrictMode>
);

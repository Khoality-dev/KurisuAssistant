import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { CharacterWindowApp } from './CharacterWindowApp';

const isCharacterWindow = new URLSearchParams(window.location.search).get('window') === 'character';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCharacterWindow ? <CharacterWindowApp /> : <App />}
  </React.StrictMode>
);

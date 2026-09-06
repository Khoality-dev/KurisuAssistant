/**
 * The screens.
 *
 * This is the one package that renders, and so the only one allowed a widget
 * library — `boundaries.test.ts` keeps that true of the others. An app imports
 * what it mounts from here and supplies nothing but a root element.
 */
export { App } from './App';
export { CharacterWindowApp } from './CharacterWindowApp';
export { theme } from './theme/theme';

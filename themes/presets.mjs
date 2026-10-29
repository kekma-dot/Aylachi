import { defaultThemeTokens } from './schema.mjs';

function preset(id, name, base, colors) {
  const tokens = defaultThemeTokens(base);
  return { id, name, tokens: { ...tokens, colors: { ...tokens.colors, ...colors } } };
}

export const THEME_PRESETS = [
  preset('aylachi-light', 'Aylachi Light', 'light', {}),
  preset('aylachi-dark', 'Aylachi Dark', 'dark', {}),
  preset('paper', 'Paper', 'light', { background: '#f5f1e8', surface: '#fffdf7', text: '#34312d', muted: '#817a70', accent: '#8a6f55', border: '#ddd5c8', accentSoft: '#eee5d8', accentStrong: '#ddcfbc' }),
  preset('graphite', 'Graphite', 'dark', { background: '#232425', surface: '#2d2f30', text: '#eeeeeb', muted: '#a3a5a3', accent: '#b5b8b2', border: '#494b4b', accentSoft: '#3a3c3c', accentStrong: '#505350' }),
  preset('sage', 'Sage', 'light', { background: '#eef1eb', surface: '#fbfcf8', text: '#29332d', muted: '#748077', accent: '#687f6d', border: '#d2dad2', accentSoft: '#dfe8df', accentStrong: '#c7d6c8' }),
  preset('midnight', 'Midnight', 'dark', { background: '#202630', surface: '#29313d', text: '#e8edf3', muted: '#9ba8b7', accent: '#9eb7d5', border: '#435064', accentSoft: '#334155', accentStrong: '#455a73' }),
];

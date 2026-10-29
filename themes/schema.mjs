const bad = () => Object.assign(new Error('INVALID_THEME_TOKENS'), { code: 'INVALID_THEME_TOKENS', status: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const COLOR = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = ['background', 'surface', 'text', 'muted', 'accent', 'border', 'accentSoft', 'accentStrong'];
const DEFAULTS = {
  light: {
    colors: { background: '#f4f2ed', surface: '#fffdf9', text: '#29272a', muted: '#7d777b', accent: '#82729f', border: '#d8d4d3', accentSoft: '#e9e3f2', accentStrong: '#d8cde7' },
    shadow: { x: 7, y: 7, blur: 0, color: '#42434a', opacity: 0.09 },
  },
  dark: {
    colors: { background: '#242329', surface: '#302e35', text: '#eeeaf0', muted: '#aaa2ad', accent: '#c4b2e0', border: '#4b4750', accentSoft: '#40394a', accentStrong: '#554865' },
    shadow: { x: 7, y: 7, blur: 0, color: '#000000', opacity: 0.2 },
  },
};
function exact(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw bad();
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw bad();
  return value;
}
export function defaultThemeTokens(base = 'light') {
  if (!Object.hasOwn(DEFAULTS, base)) throw bad();
  return { base, colors: { ...DEFAULTS[base].colors }, radius: 0, shadow: { ...DEFAULTS[base].shadow },
    typography: { family: 'system', size: 14 }, density: 'comfortable' };
}
export function snapshotThemeTokens(input) {
  exact(input, ['base', 'colors', 'radius', 'shadow', 'typography', 'density']);
  const base = input.base ?? 'light';
  const result = defaultThemeTokens(base);
  if (input.colors !== undefined) {
    exact(input.colors, COLOR_KEYS);
    for (const key of COLOR_KEYS) {
      const value = input.colors[key] ?? result.colors[key];
      if (typeof value !== 'string' || !COLOR.test(value)) throw bad();
      result.colors[key] = value.toLowerCase();
    }
  }
  result.radius = integer(input.radius ?? result.radius, 0, 24);
  if (input.shadow !== undefined) {
    exact(input.shadow, ['x', 'y', 'blur', 'color', 'opacity']);
    result.shadow = {
      x: integer(input.shadow.x ?? result.shadow.x, 0, 24), y: integer(input.shadow.y ?? result.shadow.y, 0, 24),
      blur: integer(input.shadow.blur ?? result.shadow.blur, 0, 48),
      color: input.shadow.color ?? result.shadow.color, opacity: input.shadow.opacity ?? result.shadow.opacity,
    };
    if (typeof result.shadow.color !== 'string' || !COLOR.test(result.shadow.color) || typeof result.shadow.opacity !== 'number' ||
        !Number.isFinite(result.shadow.opacity) || result.shadow.opacity < 0 || result.shadow.opacity > 0.5) throw bad();
    result.shadow.color = result.shadow.color.toLowerCase();
  }
  if (input.typography !== undefined) {
    exact(input.typography, ['family', 'size']);
    result.typography = { family: input.typography.family ?? 'system', size: integer(input.typography.size ?? 14, 12, 18) };
  }
  if (!['system', 'serif', 'mono'].includes(result.typography.family) || !['comfortable', 'compact'].includes(input.density ?? 'comfortable')) throw bad();
  result.density = input.density ?? 'comfortable';
  return result;
}
export function themeCssVariables(tokens) {
  const value = snapshotThemeTokens(tokens);
  const rgb = value.shadow.color.match(/[0-9a-f]{2}/gi).map(part => parseInt(part, 16)).join(',');
  const families = { system: 'Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', serif: 'Georgia,serif', mono: 'ui-monospace,SFMono-Regular,monospace' };
  return {
    '--bg': value.colors.background, '--card': value.colors.surface, '--fg': value.colors.text, '--muted': value.colors.muted,
    '--accent': value.colors.accent, '--line': value.colors.border, '--strong-line': value.colors.text,
    '--lilac': value.colors.accentSoft, '--lilac-deep': value.colors.accentStrong,
    '--node-shadow': `rgba(${rgb},${value.shadow.opacity})`, '--radius': `${value.radius}px`,
    '--shadow-x': `${value.shadow.x}px`, '--shadow-y': `${value.shadow.y}px`, '--shadow-blur': `${value.shadow.blur}px`,
    '--font-family': families[value.typography.family], '--font-size': `${value.typography.size}px`, '--space': value.density === 'compact' ? '8px' : '12px',
  };
}

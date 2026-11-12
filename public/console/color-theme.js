// Runs before first paint. Preferences contain colors only, never account data.
(() => {
  const key = 'wechatagent-console-colors';
  const defaults = { accent: '#7560d6', background: '#e5e0f4' };
  const presets = [
    ['暮紫', '#7560d6', '#e5e0f4'],
    ['森林', '#426b58', '#dce5e0'], ['海盐', '#336caa', '#dce5ef'],
    ['鸢尾', '#7660ad', '#e6e0ef'], ['玫瑰', '#ad5c78', '#efdee5'],
    ['琥珀', '#936321', '#ece4d7'], ['石墨', '#596578', '#e0e3e8'],
  ];
  const valid = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
  const normalize = value => Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, valid(value?.[name]) ? value[name].toLowerCase() : fallback]));
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const mix = (a, b, weight) => '#' + rgb(a).map((v, i) => Math.round(v * (1 - weight) + rgb(b)[i] * weight).toString(16).padStart(2, '0')).join('');
  const luminance = hex => rgb(hex).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  function readable(color, background, target = 4.5) {
    const toward = luminance(background) > .4 ? '#000000' : '#ffffff';
    for (let i = 0; contrast(color, background) < target && i < 100; i++) color = mix(color, toward, .06);
    return color;
  }
  let current;
  try { current = normalize(window.desktop?.initialColors ?? JSON.parse(localStorage.getItem(key))); } catch { current = normalize(); }
  function apply() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const bg = mix(current.background, dark ? '#11151b' : '#ffffff', dark ? .95 : .76);
    const surface = mix(current.background, dark ? '#1e232b' : '#ffffff', dark ? .96 : .98);
    const soft = mix(current.accent, surface, dark ? .82 : .9);
    const accent = dark ? mix(current.accent, '#ffffff', .38) : current.accent;
    const onAccent = contrast('#ffffff', accent) >= contrast('#11151b', accent) ? '#ffffff' : '#11151b';
    const tokens = {
      bg, surface, 'surface-2': mix(bg, surface, .5), 'surface-3': mix(current.background, surface, dark ? .87 : .6),
      border: mix(current.background, dark ? '#48515d' : '#ffffff', dark ? .9 : .34),
      text: dark ? '#edf0f5' : '#252d38', muted: readable(dark ? '#aeb7c3' : '#687383', bg),
      accent, 'accent-hover': mix(accent, onAccent === '#ffffff' ? '#000000' : '#ffffff', .12),
      'on-accent': onAccent, 'accent-soft': soft, 'accent-text': readable(accent, soft),
      'input-bg': dark ? mix(bg, surface, .3) : mix(bg, surface, .7),
    };
    // Skins own their palette. Keep the user's computed colors under a --user-
    // namespace so the glass skin can still honor accent presets, instead of
    // overwriting --bg/--accent/... with inline styles that CSS cannot beat.
    const skin = document.documentElement.dataset.skin || '';
    const prefix = skin ? '--user-' : '--';
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(prefix + name, value);
    document.documentElement.style.colorScheme = skin === 'telemetry' ? 'dark' : skin === 'print' ? 'light' : (dark ? 'dark' : 'light');
  }
  window.consoleColors = {
    presets, defaults, get: () => ({ ...current }), apply,
    set(value) {
      const next = normalize(value);
      if (window.desktop?.setColors) return window.desktop.setColors(next).then(() => { current = next; apply(); });
      // Persist before applying, so a storage failure never claims a saved change.
      localStorage.setItem(key, JSON.stringify(next));
      current = next; apply();
    },
  };
  apply();
})();

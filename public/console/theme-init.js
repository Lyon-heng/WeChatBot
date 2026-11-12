// Runs before stylesheets and first paint: sets the light/dark theme and the
// active UI skin together, so there is no flash of the wrong palette.
// Skins own their substrate; the theme preference still drives native controls
// and the glass skin. No new files are needed, which keeps the strict CSP happy.
(() => {
  const SKINS = ['telemetry', 'glass', 'print'];
  const WINDOW_ACTIONS = ['minimize', 'maximize', 'close'];
  let storedTheme, storedSkin;
  try {
    storedTheme = localStorage.getItem('wechatagent-console-theme');
    storedSkin = localStorage.getItem('wechatwb-console-skin');
  } catch {}
  const theme = window.desktop?.initialTheme ?? (['light', 'dark'].includes(storedTheme) ? storedTheme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const skin = SKINS.includes(storedSkin) ? storedSkin : (theme === 'dark' ? 'telemetry' : 'glass');
  const root = document.documentElement;
  const schemeFor = next => next === 'telemetry' ? 'dark' : next === 'print' ? 'light' : (root.dataset.theme || 'light');

  root.dataset.theme = theme;
  root.dataset.skin = skin;
  root.dataset.desktop = window.desktop ? 'true' : 'false';
  root.style.colorScheme = schemeFor(skin);

  const syncControls = () => {
    document.querySelectorAll('[data-skin]').forEach(btn => {
      const active = btn.dataset.skin === root.dataset.skin;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    });
  };
  const setSkin = next => {
    if (!SKINS.includes(next)) return;
    root.dataset.skin = next;
    root.style.colorScheme = schemeFor(next);
    try { localStorage.setItem('wechatwb-console-skin', next); } catch {}
    syncControls();
    window.consoleColors?.apply();
    // Skin changes move the window keys; let the main process re-measure them.
    window.desktop?.refreshWindowControls?.();
    document.dispatchEvent(new CustomEvent('console-skin-change', { detail: { skin: next } }));
  };
  window.consoleSkins = { list: SKINS.slice(), get: () => root.dataset.skin, set: setSkin };

  // The console draws its own minimize / maximize / close controls so they can
  // follow the active skin. Keep their labels in step with the native window.
  const syncWindowState = maximized => {
    root.dataset.windowMaximized = maximized ? 'true' : 'false';
    document.querySelectorAll('[data-window-action="maximize"]').forEach(btn => {
      const label = maximized ? '还原窗口' : '最大化窗口';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('data-base-title', label);
      btn.title = label;
    });
  };
  syncWindowState(Boolean(window.desktop?.initialMaximized));
  window.desktop?.onWindowState?.(state => syncWindowState(Boolean(state?.maximized)));

  // An older preload has no window-control channel. Never leave three buttons
  // that look clickable but silently do nothing: grey them out and tell why.
  const hasWindowApi = () => Boolean(window.desktop?.windowAction || window.desktop?.windowActionSync);
  const flagControls = available => {
    root.dataset.windowControls = available ? 'ready' : 'unavailable';
    document.querySelectorAll('[data-window-action]').forEach(btn => {
      if (!available) btn.title = '请完整退出并重新打开 WeChatBot，以启用窗口控制';
      else if (btn.dataset.baseTitle) btn.title = btn.dataset.baseTitle;
    });
  };

  const windowAction = action => {
    if (!WINDOW_ACTIONS.includes(action)) return;
    if (window.desktop?.windowAction) {
      const pending = window.desktop.windowAction(action);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } else if (window.desktop?.windowActionSync) {
      window.desktop.windowActionSync(action);
    } else {
      return;
    }
    document.querySelectorAll('[data-window-action="' + action + '"]').forEach(btn => {
      btn.classList.add('is-pressed');
      setTimeout(() => btn.classList.remove('is-pressed'), 180);
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
    syncControls();
    // The first sync runs before the buttons exist; re-apply their labels once
    // the DOM is ready (e.g. a window restored as maximized on launch).
    syncWindowState(root.dataset.windowMaximized === 'true');
    flagControls(hasWindowApi());
    window.desktop?.refreshWindowControls?.();

    // Bind each key directly. Electron's drag region can swallow delegated
    // click events on the topbar, and pointerdown still arrives where click
    // does not; the two are de-duplicated per gesture via a dataset flag.
    document.querySelectorAll('[data-window-action]').forEach(btn => {
      btn.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        btn.dataset.pointerHandled = '1';
        windowAction(btn.dataset.windowAction);
      });
      btn.addEventListener('click', event => {
        event.preventDefault();
        if (btn.dataset.pointerHandled === '1') { delete btn.dataset.pointerHandled; return; }
        windowAction(btn.dataset.windowAction);
      });
    });

    // Document-level delegation stays as a fallback for keys injected later.
    document.addEventListener('click', event => {
      if (event.defaultPrevented) return;
      const skinBtn = event.target.closest?.('[data-skin]');
      if (skinBtn) { setSkin(skinBtn.dataset.skin); return; }
      const winBtn = event.target.closest?.('[data-window-action]');
      if (winBtn) windowAction(winBtn.dataset.windowAction);
    });
    // Double-clicking the empty part of the title bar toggles maximize, the
    // same gesture the native caption bar used to provide.
    document.addEventListener('dblclick', event => {
      if (event.target.closest?.('[data-window-action]')) return;
      if (!event.target.closest?.('.topbar') || event.target.closest?.('button, a, input, select, textarea, summary, label')) return;
      windowAction('maximize');
    });
  });
})();

/* ============================================================
   Smart Queue — Accessibility Module Controller
   ------------------------------------------------------------
   Include after new.css:
     <script src="new.js" defer></script>

   Self-mounts a floating toolbar + skip-link on every page that
   includes this script. Preferences persist across visits via
   localStorage so a patient's settings (e.g. Hindi + large text)
   follow them from the kiosk to their phone.

   To hide the toolbar on unattended screens (e.g. tv-display.html),
   set this BEFORE including the script:
     <script>window.SQ_A11Y_HIDE_TOOLBAR = true;</script>
     <script src="new.js" defer></script>
   Preferences (like Hindi language) still apply — only the
   floating toolbar UI is skipped.
   ============================================================ */

(function () {
  const STORAGE_KEY = 'sq_a11y_prefs';
  const DEFAULTS = { text: 'md', theme: 'default', mode: 'default', lite: false, lang: 'en' };

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) {
      /* localStorage unavailable (private mode etc.) — prefs just won't persist */
    }
  }

  function applyPrefs(prefs) {
    const html = document.documentElement;

    if (prefs.text === 'lg' || prefs.text === 'xl') {
      html.setAttribute('data-a11y-text', prefs.text);
    } else {
      html.removeAttribute('data-a11y-text');
    }

    if (prefs.theme === 'contrast') {
      html.setAttribute('data-a11y-theme', 'contrast');
    } else {
      html.removeAttribute('data-a11y-theme');
    }

    if (prefs.mode === 'kiosk') {
      html.setAttribute('data-a11y-mode', 'kiosk');
    } else {
      html.removeAttribute('data-a11y-mode');
    }

    html.setAttribute('data-a11y-lite', prefs.lite ? 'true' : 'false');
    html.setAttribute('lang', prefs.lang);
  }

  let prefs = loadPrefs();
  applyPrefs(prefs);

  function update(patch) {
    prefs = Object.assign({}, prefs, patch);
    applyPrefs(prefs);
    savePrefs(prefs);
  }

  function mountSkipLink() {
    if (document.querySelector('.skip-link')) return;
    const skip = document.createElement('a');
    skip.href = '#main-content';
    skip.className = 'skip-link';
    skip.textContent = 'Skip to main content';
    document.body.prepend(skip);
  }

  function mountToolbar() {
    if (window.SQ_A11Y_HIDE_TOOLBAR || document.querySelector('.a11y-toolbar')) return;

    const wrap = document.createElement('div');
    wrap.className = 'a11y-toolbar';
    wrap.innerHTML =
      '<button class="a11y-toggle-btn" aria-label="Accessibility settings" aria-expanded="false">A+</button>' +
      '<div class="a11y-panel hidden" role="dialog" aria-label="Accessibility settings">' +
        '<h4>Accessibility</h4>' +
        '<div class="a11y-row"><span>Text size</span><div class="a11y-btn-group" data-group="text">' +
          '<button data-value="md">A</button><button data-value="lg">A+</button><button data-value="xl">A++</button>' +
        '</div></div>' +
        '<div class="a11y-row"><span>High contrast</span><label class="a11y-switch">' +
          '<input type="checkbox" data-toggle="theme" /><span></span></label></div>' +
        '<div class="a11y-row"><span>Large touch targets</span><label class="a11y-switch">' +
          '<input type="checkbox" data-toggle="mode" /><span></span></label></div>' +
        '<div class="a11y-row"><span>Low-data mode</span><label class="a11y-switch">' +
          '<input type="checkbox" data-toggle="lite" /><span></span></label></div>' +
        '<div class="a11y-row"><span>Language</span><div class="a11y-btn-group" data-group="lang">' +
          '<button data-value="en">EN</button><button data-value="hi">\u0939\u093F\u0902</button>' +
        '</div></div>' +
      '</div>';
    document.body.appendChild(wrap);

    const panel = wrap.querySelector('.a11y-panel');
    const toggleBtn = wrap.querySelector('.a11y-toggle-btn');

    toggleBtn.addEventListener('click', function () {
      const nowHidden = panel.classList.toggle('hidden');
      toggleBtn.setAttribute('aria-expanded', String(!nowHidden));
    });

    function syncUI() {
      wrap.querySelectorAll('[data-group="text"] button').forEach(function (b) {
        b.classList.toggle('active', b.dataset.value === prefs.text);
      });
      wrap.querySelectorAll('[data-group="lang"] button').forEach(function (b) {
        b.classList.toggle('active', b.dataset.value === prefs.lang);
      });
      wrap.querySelector('[data-toggle="theme"]').checked = prefs.theme === 'contrast';
      wrap.querySelector('[data-toggle="mode"]').checked = prefs.mode === 'kiosk';
      wrap.querySelector('[data-toggle="lite"]').checked = !!prefs.lite;
    }
    syncUI();

    wrap.querySelectorAll('[data-group="text"] button').forEach(function (b) {
      b.addEventListener('click', function () { update({ text: b.dataset.value }); syncUI(); });
    });
    wrap.querySelectorAll('[data-group="lang"] button').forEach(function (b) {
      b.addEventListener('click', function () { update({ lang: b.dataset.value }); syncUI(); });
    });
    wrap.querySelector('[data-toggle="theme"]').addEventListener('change', function (e) {
      update({ theme: e.target.checked ? 'contrast' : 'default' });
    });
    wrap.querySelector('[data-toggle="mode"]').addEventListener('change', function (e) {
      update({ mode: e.target.checked ? 'kiosk' : 'default' });
    });
    wrap.querySelector('[data-toggle="lite"]').addEventListener('change', function (e) {
      update({ lite: e.target.checked });
    });
  }

  function init() {
    mountSkipLink();
    mountToolbar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposed for programmatic use (e.g. a "Continue in Hindi" button on your landing page)
  window.SQAccessibility = { getPrefs: function () { return Object.assign({}, prefs); }, setPrefs: update };
})();
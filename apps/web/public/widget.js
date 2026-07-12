/**
 * OrderOS embeddable widget loader.
 *
 * This file runs on OTHER PEOPLE'S WEBSITES — WordPress themes, Wix, Squarespace,
 * hand-written HTML from 2011. That constraint drives every decision here:
 *
 *   - No dependencies, no framework, no build step. It is plain ES5-compatible
 *     JS so it runs in whatever the customer's phone happens to have.
 *   - Everything lives in a Shadow DOM. The host page's CSS cannot reach into our
 *     button (a WordPress theme with `button { display: none !important }` is not
 *     hypothetical), and our styles cannot leak out and break their layout.
 *   - The ordering UI itself is an <iframe>. It is the only boundary that holds:
 *     their CSS can't touch our checkout, and our JS can't touch their page.
 *   - One global, `window.OrderOS`, so a site can wire its own button to us.
 *
 * Load it like this:
 *   <script src="https://cdn.orderos.ai/widget.js" data-orderos-key="wk_..." defer></script>
 */
(function () {
  'use strict';

  // Guard against the snippet being pasted twice — which happens constantly on
  // WordPress, where it ends up in both the theme header and a plugin.
  if (window.OrderOS && window.OrderOS.__loaded) return;

  var NS = 'orderos';

  // Where this script was served from is where the API and embed app live. That
  // means the snippet carries no URLs to get wrong, and a self-hosted deployment
  // works with no extra configuration.
  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf('widget.js') !== -1) return all[i];
      }
      return null;
    })();

  if (!script) {
    console.error('[OrderOS] Could not locate the widget script tag.');
    return;
  }

  var widgetKey = script.getAttribute('data-orderos-key') || script.getAttribute('restaurant-id');
  if (!widgetKey) {
    console.error('[OrderOS] Missing data-orderos-key on the script tag.');
    return;
  }

  var scriptOrigin = new URL(script.src, window.location.href).origin;
  var apiBase = script.getAttribute('data-api-url') || scriptOrigin.replace('://', '://api.');
  // Local dev and single-host deploys: the API is not on an api.* subdomain.
  if (script.getAttribute('data-api-url')) apiBase = script.getAttribute('data-api-url');

  var embedBase = scriptOrigin;

  /**
   * A random id per visit, used to deduplicate funnel events server-side.
   * sessionStorage, not a cookie: it dies with the tab, is not sent to any other
   * host, and cannot follow anyone anywhere. This is deliberately not a tracker.
   */
  var sessionId = (function () {
    try {
      var existing = sessionStorage.getItem('orderos_sid');
      if (existing) return existing;
      var fresh = 'sid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('orderos_sid', fresh);
      return fresh;
    } catch (e) {
      // Safari in private mode throws on sessionStorage. Fall back to per-load.
      return 'sid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  })();

  function track(type) {
    try {
      var body = JSON.stringify({ type: type, sessionId: sessionId });
      // keepalive so the event survives the page being closed right after a click.
      fetch(apiBase + '/api/widget/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Widget-Key': widgetKey },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      /* analytics must never break the page */
    }
  }

  var state = {
    open: false,
    config: null,
    host: null, // shadow root host element
    root: null, // shadow root
    iframe: null,
    overlay: null,
    button: null,
    cartCount: 0,
  };

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  var POSITIONS = {
    BOTTOM_RIGHT: 'bottom: 20px; right: 20px;',
    BOTTOM_LEFT: 'bottom: 20px; left: 20px;',
    TOP_RIGHT: 'top: 20px; right: 20px;',
    TOP_LEFT: 'top: 20px; left: 20px;',
  };

  function styles(settings) {
    var pos = POSITIONS[settings.position] || POSITIONS.BOTTOM_RIGHT;

    return (
      ':host { all: initial; }' +
      // z-index: every site has a sticky header that will fight us. This is the
      // one place a very high z-index is the correct answer rather than a smell.
      '.oos-btn {' +
      'position: fixed;' +
      pos +
      'z-index: 2147483000;' +
      'display: inline-flex; align-items: center; gap: 8px;' +
      'padding: 14px 22px;' +
      'font-family: ' +
      settings.fontFamily +
      ';' +
      'font-size: 15px; font-weight: 600; line-height: 1;' +
      'color: ' +
      settings.textColor +
      ';' +
      'background: ' +
      settings.primaryColor +
      ';' +
      'border: none; border-radius: ' +
      settings.borderRadius +
      'px;' +
      'cursor: pointer;' +
      'box-shadow: 0 4px 14px rgba(0,0,0,.18);' +
      'transition: transform .15s ease, box-shadow .15s ease;' +
      '-webkit-tap-highlight-color: transparent;' +
      '}' +
      '.oos-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.22); }' +
      '.oos-btn:focus-visible { outline: 3px solid rgba(0,0,0,.35); outline-offset: 2px; }' +
      '.oos-badge {' +
      'display: inline-flex; align-items: center; justify-content: center;' +
      'min-width: 20px; height: 20px; padding: 0 6px;' +
      'font-size: 12px; font-weight: 700;' +
      'background: rgba(255,255,255,.25); border-radius: 10px;' +
      '}' +
      '.oos-overlay {' +
      'position: fixed; inset: 0; z-index: 2147483001;' +
      'background: rgba(0,0,0,.55);' +
      'display: flex; align-items: center; justify-content: center;' +
      'padding: 24px;' +
      'opacity: 0; transition: opacity .2s ease;' +
      '}' +
      '.oos-overlay.oos-visible { opacity: 1; }' +
      '.oos-frame {' +
      'width: 100%; max-width: 460px; height: 100%; max-height: 720px;' +
      'border: none; border-radius: ' +
      settings.borderRadius +
      'px;' +
      'background: #fff;' +
      'box-shadow: 0 24px 60px rgba(0,0,0,.35);' +
      '}' +
      '.oos-full .oos-frame { max-width: none; max-height: none; border-radius: 0; }' +
      '.oos-full { padding: 0; }' +
      // Below 560px a modal is just a worse full-screen page. Always go full.
      '@media (max-width: 560px) {' +
      '.oos-overlay { padding: 0; }' +
      '.oos-frame { max-width: none; max-height: none; border-radius: 0; }' +
      '.oos-btn { padding: 12px 18px; font-size: 14px; }' +
      '}' +
      '.oos-inline { width: 100%; border: none; display: block; }'
    );
  }

  function mountShadowHost() {
    var host = document.createElement('div');
    host.id = 'orderos-widget';
    // Belt and braces: even the host element is neutralised against inherited layout.
    host.style.cssText = 'all: initial; position: static;';
    document.body.appendChild(host);

    // Shadow DOM is what makes this survive a hostile stylesheet. `closed` so the
    // host page can't reach in and mutate our nodes either.
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

    state.host = host;
    state.root = root;
    return root;
  }

  function buildIframe(path) {
    var iframe = document.createElement('iframe');
    iframe.src =
      embedBase +
      '/embed/' +
      encodeURIComponent(widgetKey) +
      path +
      '?parent=' +
      encodeURIComponent(window.location.origin) +
      '&sid=' +
      encodeURIComponent(sessionId);

    iframe.setAttribute('title', 'Order online');
    // allow-same-origin is required (the embed app needs its own localStorage for
    // the cart). It is safe here because the iframe's origin is OURS, not the
    // host page's — same-origin refers to orderos.ai, so it gains nothing over
    // the restaurant's site.
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
    );
    iframe.setAttribute('allow', 'payment; geolocation');
    return iframe;
  }

  function renderButton(settings) {
    var button = document.createElement('button');
    button.className = 'oos-btn';
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');

    var label = document.createElement('span');
    label.textContent = settings.buttonText;
    button.appendChild(label);

    var badge = document.createElement('span');
    badge.className = 'oos-badge';
    badge.style.display = 'none';
    button.appendChild(badge);

    button.addEventListener('click', function () {
      open();
    });

    state.button = button;
    state.badge = badge;
    return button;
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  function open() {
    if (state.open || !state.config) return;
    state.open = true;
    track('OPEN');

    var settings = state.config.settings;

    var overlay = document.createElement('div');
    overlay.className = 'oos-overlay' + (settings.fullPage ? ' oos-full' : '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Order from ' + state.config.restaurant.name);

    var iframe = buildIframe('');
    iframe.className = 'oos-frame';
    overlay.appendChild(iframe);

    // Click the backdrop to dismiss — but only the backdrop, never a click that
    // originated inside the frame.
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    state.root.appendChild(overlay);
    state.overlay = overlay;
    state.iframe = iframe;

    // Next frame, so the opacity transition actually runs.
    requestAnimationFrame(function () {
      overlay.classList.add('oos-visible');
    });

    // The host page must not scroll behind an open modal. Remember what it was —
    // some sites already set overflow, and stomping it on close breaks them.
    state.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (!state.open) return;
    state.open = false;

    document.removeEventListener('keydown', onKeydown);
    document.body.style.overflow = state.prevOverflow || '';

    if (state.overlay) {
      state.overlay.classList.remove('oos-visible');
      var overlay = state.overlay;
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 200);
    }

    state.overlay = null;
    state.iframe = null;

    if (state.button) state.button.focus();
  }

  function onKeydown(e) {
    if (e.key === 'Escape' || e.keyCode === 27) close();
  }

  // -------------------------------------------------------------------------
  // Messages from the iframe
  // -------------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    // The host page may embed other iframes; any of them can postMessage here.
    // Only trust messages that came from OUR origin and carry our namespace.
    if (event.origin !== embedBase) return;

    var msg = event.data;
    if (!msg || msg.ns !== NS) return;

    switch (msg.type) {
      case 'CLOSE':
        close();
        break;

      case 'CART_COUNT':
        state.cartCount = msg.count || 0;
        if (state.badge) {
          state.badge.textContent = String(state.cartCount);
          state.badge.style.display = state.cartCount > 0 ? 'inline-flex' : 'none';
        }
        break;

      case 'RESIZE':
        // Inline mode only: an iframe has no intrinsic height, so the embedded
        // app measures its own content and tells us.
        if (state.inlineFrame && msg.height) {
          state.inlineFrame.style.height = msg.height + 'px';
        }
        break;

      case 'OPEN_CHECKOUT':
        /**
         * Stripe Checkout sets frame-ancestors and will not render in an iframe.
         *
         * So the HOST page opens it, in a new tab. The customer's tab on the
         * restaurant's website stays exactly where it is — which is the entire
         * point of this module — and the widget polls the order in the background,
         * flipping to its tracking view the moment payment lands.
         *
         * window.open must be called from the top document; a sandboxed iframe
         * cannot reliably do it, which is why this hop through postMessage exists
         * at all rather than the iframe just calling window.open itself.
         */
        var tab = window.open(msg.url, '_blank', 'noopener,noreferrer');
        if (!tab) {
          // Popup blocked. Tell the iframe so it can render a "click here to pay"
          // link, which counts as a user gesture and will be allowed through.
          post({ ns: NS, type: 'CHECKOUT_BLOCKED' });
        }
        break;
    }
  });

  function post(message) {
    if (state.iframe && state.iframe.contentWindow) {
      state.iframe.contentWindow.postMessage(message, embedBase);
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function boot() {
    fetch(apiBase + '/api/widget/config', {
      headers: { 'X-Widget-Key': widgetKey },
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) {
            throw new Error(body.message || 'Widget could not load (' + res.status + ')');
          });
        }
        return res.json();
      })
      .then(function (config) {
        state.config = config;
        render(config);
        track('VIEW');
      })
      .catch(function (err) {
        // Loudly in the console, silently on the page. A restaurant's customers
        // should never see our error; their developer should see it immediately.
        console.error('[OrderOS] ' + err.message);
      });
  }

  function render(config) {
    var settings = config.settings;
    var root = mountShadowHost();

    var styleTag = document.createElement('style');
    styleTag.textContent = styles(settings);
    root.appendChild(styleTag);

    // The restaurant is closed and they've asked us to hide rather than take an
    // order they can't cook.
    if (settings.hideWhenClosed && !config.restaurant.isOpen) return;

    if (settings.mode === 'INLINE_MENU') {
      renderInline(settings);
      return;
    }

    if (settings.mode === 'MANUAL_TRIGGER') {
      // No UI of ours. The site calls window.OrderOS.open() from its own button.
      return;
    }

    root.appendChild(renderButton(settings));
  }

  /**
   * Inline mode: the menu renders in the page flow, wherever the site put
   * <div id="orderos-menu">. Checkout still opens as a modal on top, because a
   * checkout that scrolls away inside a page is a checkout people abandon.
   */
  function renderInline(settings) {
    var container = document.getElementById('orderos-menu');
    if (!container) {
      console.error(
        '[OrderOS] Inline mode needs a container: add <div id="orderos-menu"></div> where the menu should appear.',
      );
      return;
    }

    var iframe = buildIframe('/menu');
    iframe.className = 'oos-inline';
    iframe.style.width = '100%';
    iframe.style.height = '600px'; // replaced by the first RESIZE message
    iframe.style.border = 'none';

    container.appendChild(iframe);
    state.inlineFrame = iframe;
  }

  // -------------------------------------------------------------------------
  // Public API — lets a site wire its own "Order Now" button to us.
  // -------------------------------------------------------------------------

  window.OrderOS = {
    __loaded: true,
    open: open,
    close: close,
    /** Number of items currently in the cart. */
    cartCount: function () {
      return state.cartCount;
    },
    /** Attach to an existing element: OrderOS.attach('#my-order-button') */
    attach: function (selector) {
      var elements = document.querySelectorAll(selector);
      for (var i = 0; i < elements.length; i++) {
        elements[i].addEventListener('click', function (e) {
          e.preventDefault();
          open();
        });
      }
      return elements.length;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

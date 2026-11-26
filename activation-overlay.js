// Painted at document_start, before Facebook has rendered anything.
//
// Clicking the toolbar icon opens a tab and the tool switches itself on from
// friends-page.js, which runs at document_idle — after Facebook has parsed and
// begun rendering. Until then the click produced a plain, slowly loading
// Facebook page with no sign the extension had heard it. This covers that gap:
// the worker is asked whether this tab is one it just opened, and if so an
// overlay goes up immediately and stays until the controls are ready.
//
// It lives on documentElement rather than body: body may not exist yet at
// document_start, and Facebook's React root never owns this node, so a render
// pass cannot remove it.
(() => {
  const HOST_ID = "cms-activation-overlay";
  // Longer than the friends page's own scan grace period, so the overlay is
  // normally dismissed by the page and this is only a stuck-state release.
  const MAX_LIFETIME_MS = 20_000;

  let host = null;
  let expiryTimer = null;

  const msg = (key, fallback) => {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  };

  function remove() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    host?.remove();
    host = null;
  }

  function show() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const dir = msg("@@bidi_dir", "ltr");
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        .sheet{position:fixed;inset:0;z-index:2147483647;display:grid;align-content:center;justify-items:center;gap:14px;
          background:#18191af2;color:#f5f6f7;text-align:center;
          font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:default}
        .spinner{width:34px;height:34px;border:3px solid #ffffff26;border-top-color:#2d88ff;border-radius:50%;
          animation:cms-spin .8s linear infinite}
        @media (prefers-reduced-motion:reduce){.spinner{animation-duration:2.4s}}
        @keyframes cms-spin{to{transform:rotate(360deg)}}
        .brand{font-weight:800;letter-spacing:.01em}
        .note{max-width:300px;color:#b0b3b8;font-size:12px}
      </style>
      <div class="sheet" role="status" aria-live="polite" dir="${dir}">
        <span class="spinner" aria-hidden="true"></span>
        <span class="brand"></span>
        <span class="note"></span>
      </div>`;
    // textContent, not interpolation: translated strings are data here.
    shadow.querySelector(".brand").textContent = msg("panelTitle", "THE F");
    shadow.querySelector(".note").textContent = msg("loadingFriends", "Loading your friends…");
    // Never trap the page: a click releases it, as does the expiry below.
    shadow.querySelector(".sheet").addEventListener("click", remove);
    document.documentElement.appendChild(host);
    expiryTimer = setTimeout(remove, MAX_LIFETIME_MS);
  }

  // friends-page.js reaches this through the shared isolated world once its own
  // controls are ready, or once it has given up on reading the page.
  globalThis.CmsActivationOverlay = { show, remove };

  // Only Facebook pages this activation could plausibly land on are worth waking
  // the worker for: its own friends list, or the root it is sent to when signed
  // out. Every other Facebook page load stays untouched.
  function eligible() {
    const path = location.pathname;
    if (path === "/" || path === "/home.php") return true;
    if (path === "/profile.php") return /(^|&)sk=friends(_all)?(&|$)/.test(location.search.slice(1));
    return /^\/[^/]+\/friends(_all)?\/?$/.test(path) || /(^|&)sk=friends(_all)?(&|$)/.test(location.search.slice(1));
  }

  // openFriendsWorkspace can only mark the tab after chrome.tabs.create has
  // handed back its id, so on a warm cache this script can run first and get
  // "not pending" for a tab that is about to be marked. A few short retries
  // close that window; they stop at the first answer of either kind once the
  // mark has had time to land.
  const ASK_DELAYS_MS = [0, 120, 260, 500];

  async function askAndShow() {
    for (const delay of ASK_DELAYS_MS) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (host?.isConnected) return;
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: "ACTIVATION_PENDING" });
      } catch {
        return; // No worker to answer: nothing to wait for.
      }
      if (response?.pending) {
        show();
        return;
      }
    }
  }

  if (!eligible()) return;
  void askAndShow();
})();

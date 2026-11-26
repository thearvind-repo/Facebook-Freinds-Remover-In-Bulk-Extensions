// THE F — the whole product, running on the user's own Facebook
// friends page. The toolbar icon (or Activate on the installed page) opens that
// page and marks the tab; this script then adds a checkbox to every friend card
// and a small control card. Friend names never leave the tab: only the numeric
// profile id of a selected friend is handed to the worker for the removal.
(() => {
  if (window.__cmsFriendsPageLoaded) return;
  window.__cmsFriendsPageLoaded = true;

  const core = globalThis.CmsFriendsCore;
  const ACTIVE_KEY = "cms_unfriender_active_v3";
  const MINIMIZED_KEY = "cms_unfriender_minimized_v3";
  // Set once a friends_all tab with no cards has been sent to sk=friends.
  const FRIENDS_TAB_FALLBACK_KEY = "cms_unfriender_friends_tab_fallback_v1";
  const HOOK_SOURCE = "CMS_FRIENDS_HOOK";
  const CONTROL_SOURCE = "CMS_FRIENDS_CONTROL";
  const MAX_CONSECUTIVE_FAILURES = 3;
  // Menu failures of the same kind in a row before the batch pauses and the
  // user is offered a way out (English Facebook, or the side panel). Two
  // ended too many free runs on a one-off slow menu, before the daily cap.
  const HELP_AFTER_FAILURES = 3;
  // The selection survives the reload that follows a Facebook language change.
  const RESUME_KEY = "cms_unfriender_resume_v1";
  // The selection left over at the daily cap, kept on this device so free
  // users can carry on tomorrow (docs/CONVERSION.md: preserve selections at
  // the cap). Friend keys only; it never leaves chrome.storage.local.
  const SAVED_SELECTION_KEY = "cms_unfriender_saved_selection_v1";
  const SAVED_SELECTION_DAYS = 7;
  // Facebook renders the grid well after document_idle. An empty scan is only
  // treated as "cards not recognised" once the page has had this long.
  const EMPTY_SCAN_GRACE_MS = 12_000;
  const LOAD_PASS_DELAY_MS = 1_200;
  const MAX_LOAD_PASSES = 400;
  const STABLE_PASSES_TO_FINISH = 5;
  // How long Facebook gets to show each step of its own menu flow, and to
  // answer the action once it has been confirmed.
  const UI_STEP_TIMEOUT_MS = 6_000;
  const UI_VERDICT_TIMEOUT_MS = 12_000;
  // Pause before the one retry of a friend whose menu did not open: longer
  // once Facebook has already been answering removals in this run.
  const MENU_RETRY_MS = 5_000;
  const MENU_RETRY_AFTER_SUCCESS_MS = 30_000;

  const known = new Map();
  const indexed = new Map();
  const selected = new Set();
  const finished = new Set();
  const harvested = new WeakSet();
  const pageEventsSent = new Set();
  const diagnosticsSent = new Set();
  let host = null;
  let shadow = null;
  let observer = null;
  let scanQueued = false;
  let emptyTimer = null;
  // Facebook can take seconds to render the friends list, and the panel used to
  // open onto "0 found" with instructions to select people who were not there
  // yet. The controls stay behind a spinner until the first scan finds cards,
  // or until the grace period ends and the page reports it cannot read them.
  let settled = false;
  let locationTimer = null;
  let accountId = null;
  // Using Facebook as a Page, per the worker. Personal profiles only: the
  // tool steps aside with guidance while this is true.
  let actingAsPage = false;
  let loading = false;
  let running = false;
  let stopping = false;
  let access = null;
  let speed = "fast";
  let confirmResolver = null;

  const msg = (key, fallback, substitutions = []) =>
    chrome.i18n.getMessage(key, substitutions) ||
    String(fallback).replace(/\$(\d)/g, (_, index) => substitutions[Number(index) - 1] ?? "");
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  // Translated text interpolated into the control card markup.
  const t = (key, fallback) => escapeHtml(msg(key, fallback));
  // Never throws: an invalidated extension context throws synchronously, and
  // a browser whose sendMessage returns no promise (seen as a user-script
  // host in v66.11 reports) made `.catch` itself the TypeError that stopped
  // boot, activation and the entitlement read.
  const send = message => {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  function reportError(reason, code, context) {
    const error = reason instanceof Error ? reason : new Error(String(reason || "Unknown page error"));
    void send({
      type: "CMS_REPORT_CRASH",
      source: "content:friends-page",
      code,
      context,
      error: { name: error.name, message: error.message, stack: error.stack }
    });
  }

  // Uncaught errors outside a guarded handler. Only this extension's own
  // frames are reported; Facebook's errors arrive on the same window and are
  // never ours to file.
  const ownFrame = value => {
    try { return String(value || "").includes(chrome.runtime.getURL("")); } catch { return false; }
  };
  window.addEventListener("error", event => {
    if (ownFrame(event.filename) || ownFrame(event.error?.stack)) reportError(event.error || event.message, "friends_uncaught_error");
  });
  window.addEventListener("unhandledrejection", event => {
    if (ownFrame(event.reason?.stack)) reportError(event.reason, "friends_unhandled_rejection");
  });

  // Wraps every UI handler: a failure in the page tool is reported, never thrown
  // into Facebook's own error handling.
  const guard = (code, task) => (...args) => {
    try {
      const result = task(...args);
      if (result && typeof result.catch === "function") result.catch(error => reportError(error, code));
    } catch (error) {
      reportError(error, code);
    }
  };

  function pageEvent(name) {
    if (pageEventsSent.has(name)) return;
    pageEventsSent.add(name);
    void send({ type: "PAGE_EVENT", name });
  }

  // The closed-code breakage report (docs/PLATFORM-REPORTING.md), once per page.
  function diagnostic(code) {
    if (diagnosticsSent.has(code)) return;
    diagnosticsSent.add(code);
    void send({ type: "DIAGNOSTIC_SUBMIT", code });
  }

  /* ------------------------------------------------------- friend discovery */

  function collect(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(collect);
    if (value.__typename === "User" && /^\d+$/.test(value.id || "") && typeof value.name === "string") {
      const friend = { id: value.id, name: value.name, url: value.url || `https://www.facebook.com/profile.php?id=${value.id}` };
      indexed.set(`id:${friend.id}`, friend);
      // A card linked by vanity name is keyed `path:<slug>`, so indexing only
      // by id leaves it unmatched and it reaches the removal loop without the
      // numeric uid the endpoint needs. Index every address this same node
      // gives for the person: the node is authoritative for its own id, so a
      // slug taken from it cannot point at somebody else.
      for (const address of [value.url, value.profile_url, value.profileUrl]) {
        const byUrl = typeof address === "string" ? core.profileIdentity(address) : null;
        if (byUrl) indexed.set(byUrl.key, friend);
      }
      const vanity = typeof value.vanity === "string" ? value.vanity.trim().toLowerCase() : "";
      if (vanity && !vanity.includes("/")) indexed.set(`path:${vanity}`, friend);
    }
    Object.values(value).forEach(child => { if (child && typeof child === "object") collect(child); });
  }

  function parsePayload(text) {
    if (!text) return;
    try { collect(JSON.parse(text)); return; } catch {}
    text.split("\n").forEach(line => { try { collect(JSON.parse(line)); } catch {} });
  }

  // Facebook ships the first page of friends as JSON inside the HTML. It is the
  // only place a vanity-URL friend's numeric id is available without a request.
  function harvestPage() {
    document.querySelectorAll('script[type="application/json"]').forEach(script => {
      if (harvested.has(script)) return;
      harvested.add(script);
      const text = script.textContent || "";
      if (text.includes('"__typename":"User"')) parsePayload(text);
    });
  }

  function identitiesInside(element) {
    const keys = new Set();
    element.querySelectorAll("a[href]").forEach(anchor => {
      const item = core.profileIdentity(anchor.href);
      if (item) keys.add(item.key);
    });
    return keys;
  }

  // Walks up from a profile link to the largest box that still belongs to that
  // one person and looks like a card. Class names are obfuscated and change
  // with every Facebook deploy, so only structure and size are used.
  function findCard(anchors, item) {
    let candidate = null;
    let node = anchors[0].parentElement;
    for (let depth = 0; node && depth < 12 && node !== document.body; depth += 1, node = node.parentElement) {
      if (node === host || node.matches('[role="navigation"], [role="banner"]')) break;
      const people = identitiesInside(node);
      if (people.size > 1) break;
      if (!people.has(item.key) || !anchors.every(anchor => node.contains(anchor))) continue;
      // Avatars are sometimes <img> and sometimes an <image> inside an <svg>.
      if (!node.querySelector("img, svg image")) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 150 && rect.height >= 48 && rect.height <= 360) candidate = node;
    }
    return candidate;
  }

  function displayName(card, key) {
    return [...card.querySelectorAll("a[href]")]
      .filter(anchor => core.profileIdentity(anchor.href)?.key === key)
      .map(anchor => anchor.textContent.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || msg("friendFallbackName", "Facebook friend");
  }

  function addCheckbox(card, profile) {
    card.classList.add("cms-friend-card");
    card.dataset.cmsFriendKey = profile.key;
    if (card.querySelector(":scope > .cms-friend-check")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cms-friend-check";
    button.textContent = "✓";
    button.title = msg("selectFriend", "Select $1", [profile.name]);
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (running || finished.has(profile.key)) return;
      if (selected.has(profile.key)) {
        selected.delete(profile.key);
      } else {
        selected.add(profile.key);
        pageEvent("item_selected");
      }
      refresh();
    }, true);
    card.prepend(button);
  }

  let profileGroupsSeen = 0;

  function scan() {
    if (!shadow || !onActivePage()) return;
    harvestPage();
    const scope = document.querySelector('[role="main"]') || document.body;
    const groups = new Map();
    scope.querySelectorAll("a[href]").forEach(anchor => {
      if (anchor.closest(".cms-friend-card")) return;
      const item = core.profileIdentity(anchor.href);
      // The viewer is on their own friends list, so the page's owner is the
      // viewer. Their header links to themselves by vanity name, which the
      // numeric id check alone does not catch — it gave the viewer their own
      // unfriend checkbox.
      if (!item || item.key === `id:${accountId}` || item.key === currentPageKey()) return;
      const group = groups.get(item.key) || { item, anchors: [] };
      group.anchors.push(anchor);
      groups.set(item.key, group);
    });
    profileGroupsSeen = Math.max(profileGroupsSeen, groups.size);
    groups.forEach(({ item, anchors }) => {
      const card = findCard(anchors, item);
      if (!card) return;
      const metadata = indexed.get(item.key) || (item.id ? indexed.get(`id:${item.id}`) : null);
      const profile = known.get(item.key) || {
        key: item.key,
        id: item.id || metadata?.id || null,
        name: metadata?.name || displayName(card, item.key),
        url: metadata?.url || item.url
      };
      if (!profile.id && metadata?.id) profile.id = metadata.id;
      known.set(item.key, profile);
      addCheckbox(card, profile);
    });
    // Ids learned from later GraphQL pages fill in cards found earlier.
    known.forEach(profile => {
      if (!profile.id) profile.id = indexed.get(profile.key)?.id || null;
    });
    if (known.size) {
      pageEvent("items_loaded");
      clearTimeout(emptyTimer);
      if (!settled) {
        setSettled(true);
        // Otherwise "Loading your friends…" stays under a list that has loaded.
        setStatus(msg("selectInstructions", "Select friends using the checkboxes on this page."));
      }
    }
    refresh();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      try { scan(); } catch (error) { reportError(error, "friends_scan_failed"); }
    });
  }

  let emptyRetried = false;
  let loadWaited = false;
  let sparseWaited = false;
  let waitingForVisible = false;
  // Fewer links than this in the list column is a page still drawing, not a
  // list in a shape we cannot read (v66.11 reports: main=1 a=0 img=2).
  const SPARSE_LINK_COUNT = 5;

  function armEmptyCheck() {
    clearTimeout(emptyTimer);
    emptyTimer = setTimeout(guard("friends_scan_failed", checkEmptyPage), EMPTY_SCAN_GRACE_MS);
  }

  function nudgeLazyList() {
    window.scrollBy({ top: Math.round(window.innerHeight / 2), behavior: "instant" });
    window.dispatchEvent(new Event("scroll"));
  }

  const onVisibleAgain = guard("friends_scan_failed", () => {
    if (document.visibilityState === "hidden") return;
    document.removeEventListener("visibilitychange", onVisibleAgain);
    waitingForVisible = false;
    queueScan();
    armEmptyCheck();
  });

  function checkEmptyPage() {
    if (!shadow || known.size || !onActivePage()) return;
    // Scans run on animation frames, which a background tab never gets, so
    // the verdict comes from a scan made now rather than the last frame.
    scan();
    if (known.size) return;
    // A background tab is not a page we failed to read: Facebook defers
    // drawing it. The grace period starts again once the tab is shown.
    if (document.visibilityState === "hidden") {
      if (!waitingForVisible) {
        waitingForVisible = true;
        document.addEventListener("visibilitychange", onVisibleAgain);
      }
      return;
    }
    // Most reports saw no profile link at all: Facebook had not rendered the
    // grid yet. It renders the list lazily, so nudge it once and wait again.
    // Still loading: not evidence of anything yet.
    if (document.readyState !== "complete" && !loadWaited) {
      loadWaited = true;
      armEmptyCheck();
      return;
    }
    if (!emptyRetried && !profileGroupsSeen) {
      emptyRetried = true;
      nudgeLazyList();
      armEmptyCheck();
      return;
    }
    const main = document.querySelector('[role="main"]');
    const scope = main || document.body;
    const anchors = [...scope.querySelectorAll("a[href]")];
    // A list column with next to no links is still being drawn: one more
    // nudge and grace period before calling it unreadable.
    if (!sparseWaited && main && anchors.length < SPARSE_LINK_COUNT) {
      sparseWaited = true;
      nudgeLazyList();
      armEmptyCheck();
      return;
    }
    // As a Page, Facebook shows the list as the Page sees it: guidance,
    // never a report.
    void actingAsPageNow().then(guard("friends_scan_failed", pageState => {
      actingAsPage = pageState;
      if (!shadow || known.size) return;
      if (pageState) {
        setSettled(true);
        setStatus(pageGuidanceText(), "error");
        showPageGuidance();
        return;
      }
      // /<vanity>/friends_all/ renders an empty Followers/Following shell
      // where /<vanity>/friends/ lists the cards (live, 2026-11-16). One hop
      // per tab to the sk=friends form before calling the page unreadable;
      // both forms share an activation key, so the tool follows.
      if (tryFriendsTabFallback()) return;
      reportUnreadablePage(main, scope, anchors);
    }));
  }

  function tryFriendsTabFallback() {
    const target = core.friendsTabFallback(location.pathname, location.search);
    if (!target) return false;
    try {
      if (sessionStorage.getItem(FRIENDS_TAB_FALLBACK_KEY)) return false;
      sessionStorage.setItem(FRIENDS_TAB_FALLBACK_KEY, "1");
    } catch {
      return false;
    }
    void send({ type: "PAGE_BREADCRUMB", code: "friends_all_fallback" });
    location.assign(target);
    return true;
  }

  function reportUnreadablePage(main, scope, anchors) {
    const owner = accountId ? core.pageOwnerId(profileScriptText(), currentPageKey()) : null;
    setSettled(true);
    setStatus(`${msg("errorFacebookChanged", "Your friends list can’t be read right now.")} ${msg("breakageNotified", "This has been reported automatically.")}`, "error");
    reportError(new Error("friends_cards_not_found_v3"), "friends_cards_not_found", {
      phase: "scan",
      itemCount: profileGroupsSeen,
      cardCount: 0,
      surface: location.hostname,
      pageLanguage: document.documentElement.lang || "",
      viewportWidth: window.innerWidth,
      visibilityState: document.visibilityState,
      // ROI #15: what the links in the list column are, as shape counts —
      // profile / profile tab / other multi-segment / Facebook route /
      // external / other — then password fields and open dialogs (a sign-in
      // wall or a modal over the list), then the commonest Facebook-owned
      // route or tab names. Never an address, a slug or a label.
      itemType: core.linkShapeSummary(anchors.map(anchor => anchor.href), {
        pass: document.querySelectorAll('input[type="password"]').length,
        dlg: [...document.querySelectorAll('[role="dialog"]')].filter(isVisible).length
      }).slice(0, 160),
      // Counts only: was there a main column, how many links, how many avatars,
      // links without an address yet, per-card popup buttons, and whether the
      // list is the viewer's own (1), someone else's (0) or unknown (?).
      selectorKey: `main=${main ? 1 : 0} a=${anchors.length}` +
        ` img=${scope.querySelectorAll("img, svg image").length} ready=${document.readyState}` +
        ` nohref=${scope.querySelectorAll('a:not([href]), [role="link"]:not([href])').length}` +
        ` pop=${scope.querySelectorAll('[role="button"][aria-haspopup][aria-label]').length}` +
        ` own=${owner ? Number(owner === accountId) : "?"}` +
        // 1 while Facebook is used as one of the person's Pages (i_user):
        // the list then renders as the Page sees it. A boolean, never an id.
        ` page=${Number(actingAsPage)}`
    });
    diagnostic("no_friend_list");
    void offerPageSnapshot();
  }

  /* --------------------------------------------- consented layout snapshot */

  // The layout behind friends_cards_not_found, stripped of every name, photo,
  // link and text (src/content/page-snapshot.js), so the card selector can be
  // fixed from real pages. Made now, kept by the worker, and sent only when
  // the person presses the button. Never blocks or breaks the tool.
  async function offerPageSnapshot() {
    try {
      const state = await send({ type: "PAGE_SNAPSHOT_STATE" });
      if (!state?.offer || !globalThis.CmsPageSnapshot) return;
      const capturedAt = Date.now();
      const snapshot = await globalThis.CmsPageSnapshot.capture(document);
      if (!snapshot?.html) {
        void send({ type: "PAGE_BREADCRUMB", code: "layout_snapshot_too_large" });
        return;
      }
      const stored = await send({
        type: "PAGE_SNAPSHOT_STORE",
        html: snapshot.html,
        route: core.snapshotRoute(location.pathname, location.search),
        viewportWidth: window.innerWidth,
        capturedAt
      });
      if (!stored?.offer || !shadow || known.size) return;
      shadow.getElementById("snapshotSend").disabled = false;
      shadow.getElementById("snapshotResult").hidden = true;
      shadow.getElementById("snapshotOffer").hidden = false;
    } catch {
      void send({ type: "PAGE_BREADCRUMB", code: "layout_snapshot_failed" });
    }
  }

  async function sendPageSnapshot() {
    const button = shadow.getElementById("snapshotSend");
    const note = shadow.getElementById("snapshotNote");
    const result = shadow.getElementById("snapshotResult");
    button.disabled = true;
    result.hidden = true;
    const answer = await send({ type: "PAGE_SNAPSHOT_SEND" });
    const status = answer?.status || "network";
    // No answer at all: the person may press again. Any answer from the
    // server ends the offer on this page; nothing is retried automatically.
    const retry = status === "network";
    button.hidden = !retry;
    note.hidden = !retry;
    button.disabled = !retry;
    result.textContent = status === "sent"
      ? msg("snapshotSent", "Sent — thank you")
      : msg("snapshotFailed", "Couldn’t send");
    result.dataset.tone = status === "sent" ? "ok" : "error";
    result.hidden = false;
  }

  /* ------------------------------------------------- using Facebook as a Page */

  // THE F supports personal profiles only. As a Page, Facebook
  // shows the friends page as the Page sees it (followers, not friends), so
  // the user is told how to switch back, nothing is reported, and the
  // guidance clears itself once the worker sees the cookie change back.
  const PAGE_STOP_REASON = "acting_as_page_v1";
  const PAGE_GUIDANCE_ID = "cms-page-profile-guidance";
  let pageGuidance = null;

  const pageGuidanceText = () => msg("pageProfileBody",
    "THE F works with personal profiles only. You’re using Facebook as a Page. Switch to your personal profile (your profile picture at the top right, then your name) and try again.");

  function showPageGuidance() {
    globalThis.CmsActivationOverlay?.remove();
    if (pageGuidance?.isConnected) return;
    pageGuidance = document.createElement("div");
    pageGuidance.id = PAGE_GUIDANCE_ID;
    const root = pageGuidance.attachShadow({ mode: "open" });
    const dir = chrome.i18n.getMessage("@@bidi_dir") || "ltr";
    root.innerHTML = `
      <style>
        :host{all:initial}
        .card{position:fixed;top:72px;inset-inline-end:16px;z-index:2147483647;box-sizing:border-box;width:min(360px,calc(100vw - 32px));
          display:grid;gap:10px;padding:16px;border-radius:14px;background:#242526;color:#e4e6eb;box-shadow:0 12px 32px #0008;
          font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        h2{margin:0;font-size:15px;font-weight:800}
        p{margin:0;color:#b0b3b8}
        .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
        button{border:0;border-radius:8px;padding:8px 12px;font:inherit;font-weight:700;cursor:pointer}
        #switch{background:#2d88ff;color:#fff}
        #dismiss{background:transparent;color:#b0b3b8;box-shadow:inset 0 0 0 1px #3e4042}
      </style>
      <section class="card" role="status" aria-live="polite" dir="${dir}">
        <h2></h2>
        <p></p>
        <div class="row"><button id="dismiss" type="button"></button><button id="switch" type="button"></button></div>
      </section>`;
    // textContent, not interpolation: translated strings are data here.
    root.querySelector("h2").textContent = msg("pageProfileTitle", "Personal profiles only");
    root.querySelector("p").textContent = pageGuidanceText();
    root.getElementById("switch").textContent = msg("pageProfileButton", "Open Facebook to switch profile");
    root.getElementById("dismiss").textContent = msg("close", "Close");
    root.getElementById("switch").onclick = guard("friends_page_guidance_failed", () => location.assign("https://www.facebook.com/"));
    root.getElementById("dismiss").onclick = guard("friends_page_guidance_failed", hidePageGuidance);
    document.documentElement.appendChild(pageGuidance);
  }

  function hidePageGuidance() {
    pageGuidance?.remove();
    pageGuidance = null;
  }

  // Asked before an empty page is filed as unreadable: the Page state
  // explains it, and it is not a breakage.
  async function actingAsPageNow() {
    const state = await send({ type: "ACCOUNT_STATE" });
    return Boolean(state?.actingAsPage);
  }

  /* ------------------------------------------------------------------- UI */

  function setSettled(value) {
    settled = value;
    // The document_start overlay covered the wait; the panel speaks for itself
    // from here, including when it is reporting that the page cannot be read.
    if (settled) globalThis.CmsActivationOverlay?.remove();
    if (!shadow) return;
    shadow.getElementById("loading").hidden = settled;
    shadow.getElementById("speeds").hidden = !settled;
    shadow.getElementById("actions").hidden = !settled;
  }

  function setStatus(text, tone = "") {
    if (!shadow) return;
    const node = shadow.getElementById("status");
    node.textContent = text;
    node.dataset.tone = tone;
  }

  function pendingProfiles() {
    return [...selected].map(key => known.get(key)).filter(profile => profile && !finished.has(profile.key));
  }

  function refresh() {
    document.querySelectorAll(".cms-friend-card").forEach(card => {
      const key = card.dataset.cmsFriendKey;
      const active = selected.has(key);
      card.classList.toggle("cms-friend-selected", active);
      card.querySelector(":scope > .cms-friend-check")?.setAttribute("aria-pressed", String(active));
    });
    if (!shadow) return;
    if (known.size) shadow.getElementById("snapshotOffer").hidden = true;
    const pending = pendingProfiles();
    const counts = msg("foundSelectedCounts", "$1 found · $2 selected", [String(known.size), String(pending.length)]);
    shadow.getElementById("counts").textContent = counts;
    shadow.getElementById("pillCount").textContent = counts;
    shadow.getElementById("selectAll").disabled = running || !known.size;
    shadow.getElementById("unselectAll").disabled = running || !selected.size;
    shadow.getElementById("remove").disabled = running || loading || !pending.length;
    shadow.getElementById("export").disabled = running || !pending.length;
    shadow.getElementById("loadAll").disabled = running || loading;
    shadow.getElementById("stop").hidden = !running && !loading;

    const selectedSpeed = activeSpeed();
    shadow.querySelectorAll("[data-speed]").forEach(button => {
      const id = button.dataset.speed;
      button.classList.toggle("active", id === selectedSpeed);
      button.setAttribute("aria-pressed", String(id === selectedSpeed));
      button.disabled = running;
    });
  }

  function closePrompt() {
    if (!shadow) return;
    shadow.getElementById("promptBackdrop").hidden = true;
    shadow.querySelectorAll(".prompt").forEach(node => { node.hidden = true; });
  }

  function openPrompt(id) {
    closePrompt();
    setMinimized(false);
    shadow.getElementById("promptBackdrop").hidden = false;
    shadow.getElementById(id).hidden = false;
  }

  function confirmBatch(count) {
    shadow.getElementById("confirmText").textContent = msg("confirmTitleCount", "Unfriend $1 people?", [String(count)]);
    const checkbox = shadow.getElementById("confirmCheck");
    checkbox.checked = false;
    shadow.getElementById("confirmRemove").disabled = true;
    openPrompt("confirmPrompt");
    pageEvent("confirm_opened");
    return new Promise(resolve => { confirmResolver = resolve; });
  }

  // Shown when Facebook's menu failed the same way twice in a row: English
  // first when the words were the problem, the side panel first otherwise.
  function openHelp(kind) {
    const language = kind === "language";
    shadow.getElementById("helpTitle").textContent = language
      ? msg("helpLanguageTitle", "Facebook’s menu is in a language we can’t read yet")
      : msg("helpLayoutTitle", "Facebook’s menu didn’t respond as expected");
    shadow.getElementById("helpCopy").textContent = language
      ? msg("helpLanguageBody", "Removal is paused. Switch Facebook to English and it works right away, or use the side panel, which works in any language.")
      : msg("helpLayoutBody", "Removal is paused. The side panel removes friends a different way and isn’t affected.");
    const english = shadow.getElementById("helpEnglish");
    const sidePanel = shadow.getElementById("helpSidePanel");
    english.hidden = !language;
    english.className = "primary";
    sidePanel.className = language ? "secondary" : "primary";
    shadow.getElementById("helpRetry").hidden = false;
    shadow.getElementById("helpReload").hidden = true;
    openPrompt("helpPrompt");
  }

  function switchFacebookToEnglish() {
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify([...selected])); } catch {}
    window.open(`${location.origin}/settings/?tab=language`, "_blank", "noopener");
    // Facebook only re-renders in the new language after a reload.
    shadow.getElementById("helpTitle").textContent = msg("helpEnglishButton", "Switch Facebook to English");
    shadow.getElementById("helpCopy").textContent = msg("helpReloadBody", "After changing the language, reload this page to continue. Your selection is kept.");
    for (const id of ["helpEnglish", "helpSidePanel", "helpRetry"]) shadow.getElementById(id).hidden = true;
    shadow.getElementById("helpReload").hidden = false;
  }

  function restoreSelection() {
    let keys = [];
    try {
      keys = JSON.parse(sessionStorage.getItem(RESUME_KEY) || "[]");
      sessionStorage.removeItem(RESUME_KEY);
    } catch {}
    if (Array.isArray(keys)) keys.forEach(key => { if (typeof key === "string") selected.add(key); });
    void restoreSavedSelection().catch(error => reportError(error, "friends_selection_restore_failed"));
  }

  // Kept until the job is done or the user clears the selection, so a reload
  // the same day does not lose it.
  function clearSavedSelection() {
    void chrome.storage.local.remove(SAVED_SELECTION_KEY).catch(() => {});
  }

  async function saveSelectionForTomorrow(keys) {
    await chrome.storage.local.set({ [SAVED_SELECTION_KEY]: { keys: keys.slice(0, 5_000), savedAt: Date.now() } });
  }

  // Cards that load later pick the selection up as they are found.
  async function restoreSavedSelection() {
    const { [SAVED_SELECTION_KEY]: saved } = await chrome.storage.local.get(SAVED_SELECTION_KEY);
    if (!saved || !Array.isArray(saved.keys)) return;
    if (Date.now() - Number(saved.savedAt || 0) > SAVED_SELECTION_DAYS * 86_400_000) return clearSavedSelection();
    saved.keys.forEach(key => { if (typeof key === "string" && !finished.has(key)) selected.add(key); });
    queueScan();
  }

  function finishConfirmation(confirmed) {
    closePrompt();
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve?.(confirmed);
  }

  function setMinimized(minimized) {
    if (!shadow) return;
    shadow.getElementById("panel").hidden = minimized;
    shadow.getElementById("pill").hidden = !minimized;
    try { sessionStorage.setItem(MINIMIZED_KEY, minimized ? "1" : ""); } catch {}
  }

  async function refreshAccess() {
    const response = await send({ type: "ENTITLEMENT_READ" });
    if (response?.entitlement) access = response.entitlement;
    refresh();
    return access;
  }

  function chooseSpeed(next) {
    speed = next;
    void chrome.storage.local.set({ friend_sweep_v2_preferences: { speed } }).catch(() => {});
    refresh();
  }

  function activeSpeed() {
    return speed;
  }

  // Waits while showing a live countdown. Returns early when the user stops.
  async function countdown(milliseconds, label) {
    const until = Date.now() + milliseconds;
    while (Date.now() < until && !stopping) {
      setStatus(label(Math.max(1, Math.ceil((until - Date.now()) / 1000))));
      await sleep(250);
    }
  }

  /* -------------------------------------------------------------- actions */

  async function loadAll() {
    if (loading || running) return;
    loading = true;
    stopping = false;
    refresh();
    let stable = 0;
    let lastHeight = 0;
    let lastCount = 0;
    for (let pass = 0; pass < MAX_LOAD_PASSES && !stopping; pass += 1) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      window.dispatchEvent(new Event("scroll"));
      await sleep(LOAD_PASS_DELAY_MS);
      scan();
      const height = document.body.scrollHeight;
      stable = height === lastHeight && known.size === lastCount ? stable + 1 : 0;
      lastHeight = height;
      lastCount = known.size;
      setStatus(msg("loadingFoundCount", "Loading friends… $1 found", [String(known.size)]));
      if (stable >= STABLE_PASSES_TO_FINISH) break;
    }
    loading = false;
    stopping = false;
    refresh();
    if (known.size) {
      setStatus(msg("loadedFound", "$1 friends found. Select people on the page.", [String(known.size)]), "ok");
    } else {
      checkEmptyPage();
    }
  }

  function selectAll() {
    known.forEach((profile, key) => { if (!finished.has(key)) selected.add(key); });
    if (selected.size) pageEvent("item_selected");
    refresh();
  }

  // Clears the selection only. Friends already removed stay in `finished`, so
  // starting over cannot re-queue someone who is gone.
  function unselectAll() {
    selected.clear();
    clearSavedSelection();
    refresh();
  }

  /* ------------------------------------------------ Facebook's own menu */

  // Removal goes through Facebook's interface exactly as a person would do it:
  // the card's "…" button, then Unfriend (or Unfollow when Unfriend is not
  // offered), then Facebook's confirmation. The extension never sends the
  // request itself; it presses the buttons and reads Facebook's own answer.

  let pendingVerdict = null;

  // Resolves with the next unfriend/unfollow verdict the hook relays, or null.
  function awaitVerdict(action, timeoutMs = UI_VERDICT_TIMEOUT_MS) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { pendingVerdict = null; resolve(null); }, timeoutMs);
      pendingVerdict = verdict => {
        if (verdict.action !== action) return;
        clearTimeout(timer);
        pendingVerdict = null;
        resolve(verdict);
      };
    });
  }

  // A MutationObserver rather than timers or animation frames: both of those
  // are throttled or paused in a background tab, observers are not.
  function waitFor(find, timeoutMs = UI_STEP_TIMEOUT_MS) {
    return new Promise(resolve => {
      const hit = find();
      if (hit) return resolve(hit);
      const observer = new MutationObserver(() => {
        const found = find();
        if (!found) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      });
      const timer = setTimeout(() => { observer.disconnect(); resolve(find() || null); }, timeoutMs);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  const isVisible = element => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // The full sequence a mouse produces, at the element's centre, so React's
  // handlers see what they would see from a person.
  async function pressLikeUser(element) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(60);
    const rect = element.getBoundingClientRect();
    const at = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    };
    const pointer = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
    element.dispatchEvent(new PointerEvent("pointerover", pointer));
    element.dispatchEvent(new MouseEvent("mouseover", at));
    element.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    element.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
    element.dispatchEvent(new PointerEvent("pointerup", pointer));
    element.dispatchEvent(new MouseEvent("mouseup", at));
    element.dispatchEvent(new MouseEvent("click", at));
  }

  // Facebook's friend menu ignores a synthetic Escape (checked live, 2026-09)
  // but closes on a press outside it. The press goes to <body> itself, so it
  // lands on nothing that could act.
  async function dismissFacebookMenu() {
    const target = document.activeElement || document.body;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
    const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: 1, clientY: 1 };
    const pointer = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
    document.body.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    document.body.dispatchEvent(new PointerEvent("pointerup", pointer));
    document.body.dispatchEvent(new MouseEvent("mouseup", at));
    document.body.dispatchEvent(new MouseEvent("click", at));
  }

  function cardFor(key) {
    return [...document.querySelectorAll(".cms-friend-card")].find(card => card.dataset.cmsFriendKey === key) || null;
  }

  // The card's own buttons that could open its menu, best first (see
  // core.rankMenuButtons). The extension's checkbox is a native <button>,
  // never role="button", so it cannot be mistaken for one. Opening the wrong
  // one is harmless: nothing is clicked in a menu that offers neither
  // Unfriend nor Unfollow.
  function menuButtonsIn(card, name) {
    const buttons = [...card.querySelectorAll('[role="button"]')]
      .filter(button => isVisible(button) && !button.closest("a[href]") && !button.querySelector("a[href]"));
    const order = core.rankMenuButtons(buttons.map(button => ({
      label: button.getAttribute("aria-label") || "",
      text: button.innerText || "",
      popup: button.hasAttribute("aria-haspopup"),
      expanded: button.hasAttribute("aria-expanded"),
      icon: Boolean(button.querySelector("svg, i"))
    })), name);
    return order.map(index => buttons[index]);
  }

  // The card found by size can stop one box short of the row holding "…".
  // Widen to ancestors that still belong to this one person only.
  function menuButtonsFor(card, key, name) {
    let node = card;
    for (let depth = 0; node && depth < 4 && node !== document.body; depth += 1, node = node.parentElement) {
      const people = identitiesInside(node);
      if (people.size > 1 || !people.has(key)) break;
      const buttons = menuButtonsIn(node, name);
      if (buttons.length) return buttons;
    }
    return [];
  }

  // A card with visible text buttons ("Add friend", "Message") and no menu
  // button at all is someone who is not a friend.
  function hasOnlyTextButtons(card) {
    const buttons = [...card.querySelectorAll('[role="button"]')].filter(isVisible);
    return buttons.length > 0 && buttons.every(button => !button.hasAttribute("aria-haspopup") &&
      !button.hasAttribute("aria-expanded") && (button.innerText || "").trim());
  }

  // Counts only, for the crash report: which kinds of buttons the card had.
  function buttonShape(card) {
    const buttons = [...card.querySelectorAll('[role="button"]')];
    const count = test => buttons.filter(test).length;
    return `b=${buttons.length} vis=${count(isVisible)} pop=${count(b => b.hasAttribute("aria-haspopup"))}` +
      ` exp=${count(b => b.hasAttribute("aria-expanded"))} lab=${count(b => b.hasAttribute("aria-label"))}`;
  }

  function visibleMenus() {
    return [...document.querySelectorAll('[role="menu"]')].filter(isVisible);
  }

  function menuRows(menu) {
    return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')];
  }

  function describeMenu(menu) {
    return menuRows(menu).map(element => ({
      element,
      action: core.classifyMenuItem({
        text: element.innerText || element.textContent,
        iconPaths: [...element.querySelectorAll("svg path")].map(path => path.getAttribute("d") || "")
      })
    }));
  }

  // Label-free: each row's shape and icon hash, so the next report shows
  // whether Facebook renamed a row, appended the name, or swapped the icon.
  // The menu's own label is hashed too: it names the kind of menu
  // ("Friend management options") and tells the menus apart in any language.
  function menuDiagnostics(menu) {
    const rows = menuRows(menu).slice(0, 12);
    return {
      selectorKey: `k=${core.iconHash(menu.getAttribute("aria-label") || "")} ` + rows.map(row => core.menuRowShape({
        text: row.innerText || row.textContent,
        hasSvg: Boolean(row.querySelector("svg path")),
        hasSprite: Boolean(row.querySelector("i[data-visualcompletion], i[style*='background-image']"))
      })).join("."),
      menuIcons: rows.map(row => core.iconHash(row.querySelector("svg path")?.getAttribute("d") || "")).join(".")
    };
  }

  // Leaves no Facebook menu open from the previous friend: a leftover menu
  // was mistaken for "already open" and the next one was never found.
  async function closeOpenMenus() {
    if (!visibleMenus().length) return;
    await dismissFacebookMenu();
    await waitFor(() => (visibleMenus().length ? null : true), 1_500);
  }

  // Facebook first shows an empty "Loading…" dialog and swaps the menu in
  // when its data arrives — seconds later on a slow connection. While the
  // button reports aria-expanded="true" the menu is still coming: pressing
  // again would close it, which is how a slow menu used to end as
  // ui_menu_not_opened. So a second press happens only when the first one
  // never registered.
  async function openMenu(button) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const menusBefore = new Set(visibleMenus());
      await pressLikeUser(button);
      const appeared = () => visibleMenus().find(candidate => !menusBefore.has(candidate)) ||
        (button.getAttribute("aria-expanded") === "true" ? visibleMenus().at(-1) : null);
      let menu = await waitFor(appeared, UI_STEP_TIMEOUT_MS / 2);
      if (!menu && button.getAttribute("aria-expanded") === "true") menu = await waitFor(appeared, UI_STEP_TIMEOUT_MS);
      if (menu) return menu;
      if (button.getAttribute("aria-expanded") === "true") await dismissFacebookMenu();
      await closeOpenMenus();
      await sleep(800);
    }
    return null;
  }

  function newDialog(before) {
    return [...document.querySelectorAll('[role="dialog"]')]
      .filter(dialog => !before.has(dialog) && isVisible(dialog))
      .find(dialog => dialog.querySelector('[role="button"]')) || null;
  }

  // Facebook's dialog: a text-less Close in the header, then Confirm and Cancel.
  function confirmButtonIn(dialog) {
    const buttons = [...dialog.querySelectorAll('[role="button"], button')].filter(isVisible);
    const index = core.pickConfirmButton(buttons.map(button => ({
      label: button.getAttribute("aria-label") || "",
      text: button.innerText || button.textContent || ""
    })));
    return index === -1 ? null : buttons[index];
  }

  /**
   * Unfriends one card through Facebook's menu, or unfollows when Unfriend is
   * not offered. Resolves to { outcome: "unfriended" | "unfollowed" |
   * "failed", reason }, where success means Facebook's own response said so.
   */
  async function actOnCard(key) {
    const card = cardFor(key);
    if (!card) return { outcome: "failed", reason: "ui_card_missing" };
    await closeOpenMenus();
    // A card scrolled out of a long list can report zero-size buttons until
    // it is on screen again.
    card.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(120);
    const buttons = menuButtonsFor(card, key, known.get(key)?.name || "");
    if (!buttons.length) {
      if (hasOnlyTextButtons(card)) return { outcome: "failed", reason: "ui_not_friend", selectorKey: buttonShape(card) };
      return { outcome: "failed", reason: "ui_menu_button_missing", selectorKey: buttonShape(card) };
    }

    // The best-ranked button is the person's "…" on every layout seen so far;
    // the next one is tried only when the first opened some other menu.
    let choice = null;
    let unmatched = null;
    for (const button of buttons.slice(0, 2)) {
      const menu = await openMenu(button);
      if (!menu) {
        if (unmatched) break;
        return { outcome: "failed", reason: "ui_menu_not_opened", selectorKey: buttonShape(card) };
      }
      const items = describeMenu(menu);
      choice = items.find(item => item.action === "unfriend") || items.find(item => item.action === "unfollow");
      if (choice) break;
      unmatched = { itemCount: items.length, ...menuDiagnostics(menu) };
      await dismissFacebookMenu();
      await closeOpenMenus();
    }
    if (!choice) return { outcome: "failed", reason: "ui_no_menu_action", ...unmatched };

    const verdict = awaitVerdict(choice.action);
    const dialogsBefore = new Set(document.querySelectorAll('[role="dialog"]'));
    await sleep(250 + Math.round(Math.random() * 250));
    await pressLikeUser(choice.element);

    if (choice.action === "unfriend") {
      // Facebook asks for confirmation; if it answers first, there was nothing to confirm.
      const dialog = await Promise.race([
        waitFor(() => newDialog(dialogsBefore)),
        verdict.then(() => null)
      ]);
      if (dialog) {
        const confirm = confirmButtonIn(dialog);
        if (!confirm) return { outcome: "failed", reason: "ui_confirm_missing" };
        await sleep(300 + Math.round(Math.random() * 300));
        await pressLikeUser(confirm);
      }
    }

    const answer = await verdict;
    if (!answer) return { outcome: "failed", reason: "ui_no_response", action: choice.action };
    if (!answer.ok) return { outcome: "failed", reason: "ui_action_refused", action: choice.action };
    return { outcome: choice.action === "unfriend" ? "unfriended" : "unfollowed" };
  }

  function markCard(key, state) {
    document.querySelectorAll(".cms-friend-card").forEach(card => {
      if (card.dataset.cmsFriendKey !== key) return;
      card.classList.toggle("cms-friend-removed", state === "removed");
      card.classList.toggle("cms-friend-failed", state === "failed");
    });
  }

  function finishKey(key, state) {
    selected.delete(key);
    if (state === "removed") finished.add(key);
    markCard(key, state);
  }

  // The user already confirmed these friends once; "Keep trying" resumes them.
  async function removeSelected({ resume = false } = {}) {
    if (running || loading) return;
    const profiles = pendingProfiles();
    if (!profiles.length) return;
    if (!resume && !(await confirmBatch(profiles.length))) return;

    running = true;
    stopping = false;
    refresh();

    let done = 0;
    let unfollowed = 0;
    let skipped = 0;
    let failed = 0;
    let consecutive = 0;
    let stopMessage = "";
    let languageHint = false;
    let helpKind = null;
    let lastKind = null;
    let kindStreak = 0;
    const menuRetried = new Set();
    shadow.getElementById("languageHint").hidden = true;

    for (let index = 0; index < profiles.length && !stopping; index += 1) {
      const profile = profiles[index];
      setStatus(`${msg("removingName", "Removing $1…", [profile.name])} ${index + 1}/${profiles.length}`);
      // The worker throttles before each action and reports the running count after.
      const begin = await send({ type: "FRIEND_ACTION_BEGIN", speed: activeSpeed() });
      if (begin?.entitlement) access = begin.entitlement;
      let response = begin;
      let uiKind = null;
      // Switched to a Page mid-run: nothing was attempted, nothing is counted.
      if (begin?.outcome === "stopped" && begin.reason === PAGE_STOP_REASON) {
        stopMessage = pageGuidanceText();
        showPageGuidance();
        break;
      }
      if (begin?.outcome === "ready") {
        let result;
        try {
          result = await actOnCard(profile.key);
        } catch (error) {
          reportError(error, "friends_ui_action_failed");
          result = { outcome: "failed", reason: "ui_exception" };
        }
        // Closing the card mid-batch strips the cards from the page, so the
        // friend in flight comes back ui_card_missing. That is the user
        // stopping, not Facebook failing: nothing is reported or counted.
        if (stopping && result.outcome === "failed" && (!shadow || result.reason === "ui_card_missing")) break;
        // Live reports: a "…" that opens nothing comes after earlier removals
        // in the same run far more often than on the first one — Facebook is
        // slow to draw its menu, not gone. Wait and try the same friend once
        // more before it counts. Nothing was metered for the attempt.
        if (result.outcome === "failed" && result.reason === "ui_menu_not_opened" && !menuRetried.has(profile.key)) {
          menuRetried.add(profile.key);
          void send({ type: "PAGE_BREADCRUMB", code: "ui_menu_retry" });
          await countdown(done > 0 ? MENU_RETRY_AFTER_SUCCESS_MS : MENU_RETRY_MS, seconds =>
            msg("throttlePaused", "Facebook is limiting removals. Waiting $1s before trying again.", [String(seconds)]));
          if (stopping) break;
          index -= 1;
          continue;
        }
        if (result.outcome === "failed") {
          result.pageLanguage = document.documentElement.lang || "";
          uiKind = core.uiFailureKind(result.reason, result.pageLanguage, result);
          if (uiKind === "not_friend") result.reason = "ui_not_friend";
          // Facebook's menu text was not recognised: English always is.
          if (uiKind === "language") languageHint = true;
        }
        response = await send({ type: "FRIEND_ACTION_DONE", result });
        if (response) response.delayMs = begin.delayMs;
        if (response?.entitlement) access = response.entitlement;
        if (result.outcome === "unfollowed" && response?.outcome === "success") unfollowed += 1;
      }

      const outcome = response?.outcome || "failed";
      if (outcome === "throttled") {
        // Retry the same friend once Facebook's wait is over; a throttle is not
        // a failure and must not count toward the stop threshold.
        await countdown(response.retryAfterMs || 30_000, seconds =>
          msg("throttlePaused", "Facebook is limiting removals. Waiting $1s before trying again.", [String(seconds)]));
        index -= 1;
        continue;
      }
      if (uiKind === "not_friend") {
        // Not a friend (a followed Page, or someone on another person's list):
        // there is nothing to unfriend, and it says nothing about the page
        // working, so it neither stops the batch nor stays selected.
        skipped += 1;
        finishKey(profile.key, "skipped");
      } else if (outcome === "success" || outcome === "skipped") {
        if (outcome === "success") done += 1;
        // Unfollowed is reported beside, not inside, the unfriended count.
        else skipped += 1;
        consecutive = 0;
        lastKind = null;
        kindStreak = 0;
        finishKey(profile.key, "removed");
      } else if (uiKind) {
        // We could not work Facebook's menu, so nothing happened to this
        // friend: they stay selected for a retry, and Facebook was not refusing.
        failed += 1;
        markCard(profile.key, "failed");
        kindStreak = uiKind === lastKind ? kindStreak + 1 : 1;
        lastKind = uiKind;
        if (kindStreak >= HELP_AFTER_FAILURES) {
          helpKind = uiKind;
          break;
        }
      } else {
        failed += 1;
        consecutive += 1;
        finishKey(profile.key, "failed");
        if (response?.stop) {
          stopMessage = response.reason === "session_absent_v2"
            ? msg("sessionMissing", "Sign in to Facebook to continue")
            : msg("removalsPaused", "Facebook isn’t accepting removals right now. Try again in a little while.");
          if (response.reason === "session_token_unavailable_v2") diagnostic("missing_token");
          break;
        }
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
          stopMessage = msg("removalsPaused", "Facebook isn’t accepting removals right now. Try again in a little while.");
          diagnostic("action_rejected");
          break;
        }
      }
      refresh();
      if (index < profiles.length - 1 && !stopping) {
        await countdown(response?.delayMs || 8_000, seconds => msg("nextInSeconds", "Next in $1s", [String(seconds)]));
      }
    }


    running = false;
    stopping = false;
    refresh();
    // Closing the card mid-batch tears the panel down under the loop.
    if (!shadow) return;
    shadow.getElementById("languageHint").hidden = !languageHint || Boolean(helpKind);
    if (helpKind) {
      setStatus(msg("removedFailedResult", "$1 removed · $2 failed", [String(done), String(failed)]), "error");
      return openHelp(helpKind);
    }
    if (stopMessage) {
      setStatus(stopMessage, "error");
    } else if (unfollowed && !failed) {
      // Facebook did not offer Unfriend for these, so they were unfollowed.
      setStatus(msg("removedUnfollowedResult", "$1 unfriended · $2 unfollowed",
        [String(done - unfollowed), String(unfollowed)]), "ok");
    } else if (failed) {
      setStatus(msg("removedFailedResult", "$1 removed · $2 failed", [String(done), String(failed)]), "error");
    } else if (skipped) {
      setStatus(msg("removedWithSkipped", "Removed $1 friends · $2 skipped", [String(done), String(skipped)]), "ok");
    } else {
      setStatus(msg("removedCount", "Removed $1 friends", [String(done)]), "ok");
    }
    const remaining = pendingProfiles().length;
    if (!remaining) clearSavedSelection();
  }

  function exportSelection() {
    const rows = pendingProfiles();
    if (!rows.length) return;
    const csv = core.buildCsv(
      [msg("csvName", "Name"), msg("csvProfile", "Profile")],
      rows.map(profile => [profile.name, profile.url])
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `facebook-friends-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4_000);
  }

  /* ------------------------------------------------------------- lifecycle */

  function activeKey() {
    try { return sessionStorage.getItem(ACTIVE_KEY) || ""; } catch { return ""; }
  }

  function currentPageKey() {
    return core.friendsPageKey(location.pathname, location.search);
  }

  function onActivePage() {
    const key = activeKey();
    return Boolean(key) && (currentPageKey() === key || key === "*");
  }

  function install() {
    if (host?.isConnected) {
      host.hidden = false;
      setSettled(known.size > 0);
      queueScan();
      return;
    }
    const style = document.createElement("style");
    style.id = "cms-friends-page-style";
    style.textContent = `.cms-friend-card{position:relative!important}.cms-friend-selected{box-shadow:inset 0 0 0 3px #1877f2!important;border-radius:12px!important}.cms-friend-check{position:absolute!important;z-index:999!important;top:8px!important;inset-inline-start:8px!important;width:32px!important;height:32px!important;border:2px solid #1877f2!important;border-radius:9px!important;background:#fff!important;color:transparent!important;font:800 18px/26px Arial!important;cursor:pointer!important}.cms-friend-check[aria-pressed=true]{color:#fff!important;background:#1877f2!important}.cms-friend-removed{opacity:.45!important}.cms-friend-removed .cms-friend-check{display:none!important}.cms-friend-failed{box-shadow:inset 0 0 0 3px #e0245e!important}`;
    document.documentElement.appendChild(style);

    host = document.createElement("div");
    host.id = "cms-friends-controls";
    shadow = host.attachShadow({ mode: "open" });
    const dir = chrome.i18n.getMessage("@@bidi_dir") || "ltr";
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        .panel,.pill{position:fixed;inset-inline-end:22px;bottom:22px;z-index:2147483647;font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f5f6f7}
        .panel{box-sizing:border-box;width:min(390px,calc(100vw - 32px));padding:15px;border-radius:16px;background:#18191a;box-shadow:0 14px 44px #0006}
        .pill{display:flex;gap:10px;align-items:center;padding:10px 16px;border:0;border-radius:999px;background:#18191a;box-shadow:0 10px 30px #0006;font-weight:700;cursor:pointer}
        .pill small{color:#b0b3b8;font-weight:500}
        .top{display:flex;gap:8px;align-items:center;margin-bottom:12px}.brand{font-weight:800}#counts{flex:1;color:#b0b3b8;font-size:12px}
        .icon{min-height:28px!important;width:28px;padding:0!important}
        .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        button{min-height:40px;border:0;border-radius:10px;padding:8px 11px;background:#3a3b3c;color:#fff;font:inherit;font-size:13px;font-weight:700;line-height:1.2;cursor:pointer}
        button:disabled{opacity:.45;cursor:not-allowed}
        #remove{grid-column:1/-1;background:#e0245e}#loadAll{grid-column:1/-1;background:transparent;box-shadow:inset 0 0 0 1px #2d88ff80;color:#8ab4f8}#loadAll:not(:disabled):hover{background:#2d88ff1f}#stop{grid-column:1/-1;background:transparent;border:1px solid #666}
        #status{min-height:18px;margin-top:10px;color:#b0b3b8;font-size:12px}#status[data-tone=error]{color:#ff8fa8}#status[data-tone=ok]{color:#74d88a}
        .snapshot{margin-top:8px}.snapshot button{width:100%;min-height:32px;padding:6px 10px;background:transparent;box-shadow:inset 0 0 0 1px #ffffff33;color:#b0b3b8;font-size:12px;font-weight:600}
        .snapshot button:not(:disabled):hover{background:#ffffff0f}.snapshot .note{margin-top:5px}
        #snapshotResult{margin:6px 0 0;font-size:12px;color:#b0b3b8}#snapshotResult[data-tone=ok]{color:#74d88a}#snapshotResult[data-tone=error]{color:#ff8fa8}
        .note{margin:8px 0 0;color:#b0b3b8;font-size:11px;line-height:1.4}.note a{color:#8ab4f8}
        .speeds{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:0 0 10px}.speeds button{min-height:34px;padding:6px;font-size:11px}
        .speeds button.active{box-shadow:inset 0 0 0 2px #2d88ff;background:#263d5f}
        .footer{display:flex;flex-wrap:wrap;column-gap:14px;row-gap:6px;align-items:center;margin-top:10px;padding-top:9px;border-top:1px solid #ffffff1a;font-size:11px}
        .footer button{min-height:0;padding:2px 0;background:none;color:#8ab4f8;font:inherit;font-size:11px;font-weight:600;white-space:nowrap}
        .footer a{margin-inline-start:auto;color:#b0b3b8;text-decoration:none;white-space:nowrap}
        .backdrop{position:fixed;inset:0;z-index:3;display:grid;place-items:center;padding:18px;background:#000a}
        .prompt{box-sizing:border-box;width:min(350px,calc(100vw - 40px));max-height:calc(100vh - 36px);overflow-y:auto;padding:20px;border:1px solid #ffffff26;border-radius:16px;background:#242526;box-shadow:0 20px 60px #0008;text-align:center}
        .prompt h2{margin:0 0 8px;font-size:20px}.prompt p{margin:0 0 14px;color:#d5d7da}
        .prompt .eyebrow{margin-bottom:7px;color:#77a7ff;font-size:11px;font-weight:900;letter-spacing:.08em}
        .prompt .primary{width:100%;background:#2374e1}.prompt .danger{width:100%;background:#e0245e}.prompt .secondary{width:100%;margin-top:8px;background:transparent;border:1px solid #666}
        .confirm-line{display:flex;gap:9px;align-items:flex-start;margin:13px 0;text-align:start;color:#d5d7da}.confirm-line input{margin-top:2px}
        #loading{display:grid;justify-items:center;gap:9px;padding:18px 0 4px}
        #loading .spinner{width:26px;height:26px;border:3px solid #ffffff26;border-top-color:#2d88ff;border-radius:50%;animation:cms-spin .8s linear infinite}
        @media (prefers-reduced-motion:reduce){#loading .spinner{animation-duration:2.4s}}
        @keyframes cms-spin{to{transform:rotate(360deg)}}
        [hidden]{display:none!important}
      </style>
      <button id="pill" class="pill" type="button" dir="${dir}" hidden aria-label="${t("extActionTitle", "Open the bulk unfriender")}">
        <span>${t("panelTitle", "THE F")}</span><small id="pillCount"></small>
      </button>
      <section id="panel" class="panel" dir="${dir}">
        <div class="top">
          <span class="brand">${t("panelTitle", "THE F")}</span><span id="counts"></span>
          <button class="icon" id="minimize" type="button" aria-label="${t("minimize", "Minimize")}" title="${t("minimize", "Minimize")}">–</button>
          <button class="icon" id="close" type="button" aria-label="${t("close", "Close")}" title="${t("close", "Close")}">×</button>
        </div>
        <div id="loading" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
        </div>
        <div id="speeds" class="speeds" role="group" aria-label="${t("speed", "Speed")}">
          <button type="button" data-speed="standard">🚶 ${t("speed_standard", "Standard")}</button>
          <button type="button" data-speed="fast">🐇 ${t("speed_fast", "Fast")}</button>
          <button type="button" data-speed="super">🚀 ${t("speed_super", "Super")}</button>
        </div>
        <div id="actions" class="actions">
          <button id="loadAll" type="button">${t("loadAll", "Load all")}</button>
          <button id="selectAll" type="button">${t("selectAll", "Select all")}</button>
          <button id="unselectAll" type="button">${t("unselectAll", "Unselect all")}</button>
          <button id="remove" type="button">${t("removeSelected", "Unfriend selected")}</button>
          <button id="stop" type="button" hidden>${t("stop", "Stop")}</button>
        </div>
        <div id="status">${t("selectInstructions", "Select friends using the checkboxes on this page.")}</div>
        <div id="snapshotOffer" class="snapshot" hidden>
          <button id="snapshotSend" type="button">${t("snapshotOfferButton", "Send page layout to help fix this")}</button>
          <p id="snapshotNote" class="note">${t("snapshotOfferNote", "It contains no names, photos, links or messages.")}</p>
          <p id="snapshotResult" role="status" aria-live="polite" hidden></p>
        </div>
        <p id="languageHint" class="note" hidden>${t("languageHint", "Facebook’s menu wasn’t recognised in your Facebook language. Switching Facebook to English fixes this.")} <a href="${location.origin}/settings/?tab=language" target="_blank" rel="noopener noreferrer">${t("languageHintLink", "Change Facebook language")}</a></p>
        <div class="footer">
          <button id="export" type="button">↓ ${t("export", "Export")}</button>
          <button id="sidePanel" type="button" title="${t("openSidePanel", "Open side panel (classic mode)")}">${t("sidePanelLink", "Side panel")}</button>
        </div>
        <div id="promptBackdrop" class="backdrop" hidden>
          <section id="confirmPrompt" class="prompt" role="dialog" aria-modal="true" hidden>
            <h2 id="confirmText"></h2><p>${t("confirmDescription", "Facebook does not offer an undo for this.")}</p>
            <label class="confirm-line"><input id="confirmCheck" type="checkbox"><span>${t("confirmCheckbox", "I understand this cannot be undone")}</span></label>
            <button id="confirmRemove" type="button" class="danger" disabled>${t("removeNow", "Unfriend now")}</button>
            <button id="confirmCancel" type="button" class="secondary">${t("cancel", "Cancel")}</button>
          </section>
          <section id="helpPrompt" class="prompt" role="dialog" aria-modal="true" hidden>
            <h2 id="helpTitle"></h2><p id="helpCopy"></p>
            <button id="helpEnglish" type="button" class="primary">${t("helpEnglishButton", "Switch Facebook to English")}</button>
            <button id="helpSidePanel" type="button" class="secondary">${t("helpSidePanelButton", "Use side panel")}</button>
            <button id="helpReload" type="button" class="primary" hidden>${t("helpReloadButton", "Reload page")}</button>
            <button id="helpRetry" type="button" class="secondary">${t("helpRetryButton", "Keep trying")}</button>
          </section>
        </div>
      </section>`;
    document.documentElement.appendChild(host);

    const on = (id, code, task) => { shadow.getElementById(id).onclick = guard(code, task); };
    on("close", "friends_close_failed", deactivate);
    on("minimize", "friends_minimize_failed", () => setMinimized(true));
    on("pill", "friends_expand_failed", () => setMinimized(false));
    on("loadAll", "friends_load_failed", loadAll);
    on("selectAll", "friends_select_failed", selectAll);
    on("unselectAll", "friends_select_failed", unselectAll);
    on("remove", "friends_batch_failed", removeSelected);
    on("export", "friends_export_failed", exportSelection);
    on("snapshotSend", "friends_snapshot_failed", sendPageSnapshot);
    // Sent straight from the click so the worker still holds its user gesture,
    // which sidePanel.open() requires.
    on("sidePanel", "friends_side_panel_failed", () => send({ type: "SIDE_PANEL_OPEN" }));
    on("helpEnglish", "friends_help_failed", switchFacebookToEnglish);
    on("helpSidePanel", "friends_side_panel_failed", () => { void send({ type: "SIDE_PANEL_OPEN" }); closePrompt(); });
    on("helpReload", "friends_help_failed", () => location.reload());
    on("helpRetry", "friends_batch_failed", () => { closePrompt(); return removeSelected({ resume: true }); });
    on("stop", "friends_stop_failed", () => {
      stopping = true;
      setStatus(msg("stoppingNote", "Finishing the current removal…"));
    });
    on("confirmRemove", "friends_confirm_failed", () => finishConfirmation(true));
    on("confirmCancel", "friends_confirm_failed", () => finishConfirmation(false));
    shadow.querySelectorAll("[data-speed]").forEach(button => {
      button.onclick = guard("friends_speed_failed", () => chooseSpeed(button.dataset.speed));
    });
    shadow.querySelectorAll(".dismissPrompt").forEach(button => { button.onclick = closePrompt; });
    shadow.getElementById("confirmCheck").onchange = event => {
      shadow.getElementById("confirmRemove").disabled = !event.currentTarget.checked;
    };

    // Facebook's own GraphQL responses carry the numeric ids of friends that
    // load while scrolling. The hook only relays them into this tab.
    if (!document.getElementById("cms-friends-hook")) {
      const hook = document.createElement("script");
      hook.src = chrome.runtime.getURL("friends-page-hook.js");
      hook.id = "cms-friends-hook";
      (document.head || document.documentElement).appendChild(hook);
    }
    window.postMessage({ source: CONTROL_SOURCE, enabled: true }, "*");
    observer = new MutationObserver(queueScan);
    observer.observe(document.body, { childList: true, subtree: true });

    try { setMinimized(sessionStorage.getItem(MINIMIZED_KEY) === "1"); } catch {}
    void chrome.storage.local.get("friend_sweep_v2_preferences").then(stored => {
      const saved = stored.friend_sweep_v2_preferences?.speed;
      if (["standard", "fast", "super"].includes(saved)) speed = saved;
      return refreshAccess();
    }).catch(error => reportError(error, "friends_entitlement_failed"));

    setSettled(false);
    setStatus(msg("loadingFriends", "Loading your friends…"));
    restoreSelection();
    scan();
    clearTimeout(emptyTimer);
    emptyTimer = setTimeout(guard("friends_scan_failed", checkEmptyPage), EMPTY_SCAN_GRACE_MS);
  }

  function hide() {
    if (host) host.hidden = true;
  }

  function deactivate() {
    stopping = true;
    if (confirmResolver) finishConfirmation(false);
    try { sessionStorage.removeItem(ACTIVE_KEY); } catch {}
    clearInterval(locationTimer);
    clearTimeout(emptyTimer);
    locationTimer = null;
    window.postMessage({ source: CONTROL_SOURCE, enabled: false }, "*");
    observer?.disconnect();
    observer = null;
    document.querySelectorAll(".cms-friend-check").forEach(node => node.remove());
    document.querySelectorAll(".cms-friend-card").forEach(node => node.classList.remove(
      "cms-friend-card", "cms-friend-selected", "cms-friend-removed", "cms-friend-failed"
    ));
    document.getElementById("cms-friends-page-style")?.remove();
    host?.remove();
    host = null;
    shadow = null;
    selected.clear();
    known.clear();
    finished.clear();
  }

  // Facebook navigates without reloading. The tool follows the friends page it
  // was activated on and steps aside elsewhere, unless a batch is running.
  function watchLocation() {
    if (locationTimer) return;
    let lastHref = "";
    locationTimer = setInterval(guard("friends_location_failed", () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      if (onActivePage()) install();
      else if (!running) hide();
    }), 1_000);
  }

  // Only the page's own JSON blocks that name a profile owner, not the whole
  // multi-megabyte payload.
  function profileScriptText() {
    return [...document.querySelectorAll('script[type="application/json"]')]
      .map(script => script.textContent || "")
      .filter(text => text.includes('"userVanity"'))
      .join("\n");
  }

  function activateHere({ anywhere = false } = {}) {
    const key = currentPageKey() || (anywhere ? "*" : "");
    if (!key) return false;
    // Someone else's list: its cards are mostly people who are not the viewer's
    // friends, and every one of them used to fail as a broken menu. Answering
    // false sends the toolbar click on to the viewer's own list instead. A
    // vanity page's owner comes from the page's JSON; unknown means allowed.
    if (key !== "*" && accountId) {
      const owner = core.pageOwnerId(profileScriptText(), key);
      if (owner && owner !== accountId) return false;
    }
    try { sessionStorage.setItem(ACTIVE_KEY, key); } catch {}
    install();
    watchLocation();
    return true;
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== HOOK_SOURCE || !shadow) return;
    if (event.data.action) {
      pendingVerdict?.({ action: event.data.action, ok: Boolean(event.data.ok) });
      return;
    }
    parsePayload(event.data.response);
    queueScan();
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "ENTITLEMENT_UPDATED" && message.entitlement) {
      access = message.entitlement;
      refresh();
      return false;
    }
    if (message?.type === "FACEBOOK_ACCOUNT_CHANGED") {
      actingAsPage = Boolean(message.actingAsPage);
      if (actingAsPage) {
        // The worker stops the batch at the next friend; the user sees why.
        if (shadow) {
          if (running) stopping = true;
          setStatus(pageGuidanceText(), "error");
          showPageGuidance();
        }
      } else if (pageGuidance) {
        // Back on the personal profile: a waiting activation carries on.
        hidePageGuidance();
        if (shadow && !known.size) {
          setSettled(false);
          setStatus(msg("loadingFriends", "Loading your friends…"));
          armEmptyCheck();
        }
        boot().catch(error => reportError(error, "friends_boot_failed"));
      }
      return false;
    }
    if (message?.type !== "FRIENDS_PAGE_ACTIVATE") return false;
    try {
      respond({ ok: activateHere() });
    } catch (error) {
      reportError(error, "friends_activation_failed");
      respond({ ok: false });
    }
    return false;
  });

  async function boot() {
    const hello = await send({ type: "PAGE_HELLO" });
    accountId = hello?.accountId || null;
    actingAsPage = Boolean(hello?.actingAsPage);
    // As a Page: an activation waits here (the worker keeps its mark) and an
    // active tool steps aside until the person switches back.
    if (hello?.waiting === "page" || (actingAsPage && activeKey())) {
      showPageGuidance();
      return;
    }
    if (hello?.navigate) {
      location.assign(hello.navigate);
      return;
    }
    if (hello?.activate) {
      // After repeated redirects the worker activates wherever the tab landed —
      // unless that is someone else's list, when the viewer's own is one hop away.
      if (!activateHere({ anywhere: true }) && accountId) location.assign(core.friendsUrl(accountId));
      return;
    }
    if (activeKey()) {
      if (onActivePage()) install();
      watchLocation();
    }
  }

  boot().catch(error => reportError(error, "friends_boot_failed"));
})();

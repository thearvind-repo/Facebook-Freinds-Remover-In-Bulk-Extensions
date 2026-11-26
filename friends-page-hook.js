// Runs in the page's own world on the friends page. It observes Facebook's
// GraphQL responses so the isolated content script can name the friends it
// finds, and can tell whether an unfriend or unfollow it triggered through
// Facebook's own menu actually took. Nothing is sent anywhere: the data is
// relayed within the tab only, and this script never makes a request itself.
(() => {
  if (window.__cmsFriendsHook) return;
  window.__cmsFriendsHook = true;
  let enabled = true;
  const relay = "/api/graphql";
  // Facebook's answer to the unfriend and unfollow actions the content script
  // triggers through the page's own menu. Only the verdict leaves this
  // function — whether the person named in the answer is gone — never the
  // payload, which is how a click is known to have worked rather than assumed.
  const actionVerdict = response => {
    if (response.includes('"friend_remove"')) {
      return { action: "unfriend", ok: /"unfriended_person"\s*:\s*\{/.test(response) };
    }
    if (response.includes('"actor_unsubscribe"')) {
      return { action: "unfollow", ok: /"actor_unsubscribe"\s*:\s*\{/.test(response) };
    }
    return null;
  };
  const post = response => {
    if (!enabled || !response || response.length > 4_000_000) return;
    const verdict = actionVerdict(response);
    if (verdict) {
      window.postMessage({ source: "CMS_FRIENDS_HOOK", ...verdict }, window.location.origin);
      return;
    }
    if (!response.includes('"__typename":"User"')) return;
    window.postMessage({ source: "CMS_FRIENDS_HOOK", response }, window.location.origin);
  };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const result = originalFetch.apply(this, arguments);
    if (url?.includes(relay)) result.then(response => response.clone().text().then(post).catch(() => {})).catch(() => {});
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__cmsFriendsUrl = String(url || "");
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this.__cmsFriendsUrl?.includes(relay)) {
      this.addEventListener("load", () => post(this.responseText));
    }
    return originalSend.apply(this, arguments);
  };
  window.addEventListener("message", event => {
    if (event.source === window && event.data?.source === "CMS_FRIENDS_CONTROL") enabled = Boolean(event.data.enabled);
  });
})();

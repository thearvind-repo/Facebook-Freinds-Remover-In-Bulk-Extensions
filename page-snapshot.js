// The page layout behind a friends_cards_not_found report, stripped in the
// browser so it carries structure only. Nothing here sends anything: the page
// hands the result to the worker, which keeps it in session storage until the
// person presses "Send page layout" (docs/ERROR-HANDLING.md forbids DOM
// snapshots in automatic reports; this one is consented, one per version).
//
// Stripped: comments, scripts, styles, frames, media, link/meta/base, every
// text (replaced by its length, "[12]"), the inside of every <svg>, and every
// attribute outside a short structural allowlist. No name, photo, link,
// label or message survives. Loaded as a classic content script before
// friends-page.js, and evaluated directly by test/page-snapshot.test.js.
(root => {
  const DROP = new Set([
    "script", "style", "noscript", "template", "iframe", "object", "embed",
    "video", "audio", "canvas", "link", "meta", "base"
  ]);
  const NUMERIC = /^-?\d{1,5}$/;
  const ENUM = /^[a-z-]{1,24}$/;
  const CLASS_TOKEN = /^[A-Za-z0-9_-]{1,40}$/;
  const ATTRIBUTES = new Map([
    ["class", null],
    ["role", ENUM],
    ["aria-selected", ENUM],
    ["aria-expanded", ENUM],
    ["aria-level", NUMERIC],
    ["aria-hidden", ENUM],
    ["aria-haspopup", ENUM],
    ["tabindex", NUMERIC],
    ["type", ENUM],
    ["dir", ENUM],
    ["width", NUMERIC],
    ["height", NUMERIC]
  ]);
  /** The upload endpoint takes at most this much base64 for the layout. */
  const MAX_CHARS = 280_000;

  const ELEMENT = 1;
  const TEXT = 3;

  function cleanAttributes(element) {
    for (const { name, value } of [...element.attributes]) {
      const key = name.toLowerCase();
      if (!ATTRIBUTES.has(key)) {
        element.removeAttribute(name);
        continue;
      }
      if (key === "class") {
        const tokens = value.split(/\s+/).filter(token => CLASS_TOKEN.test(token));
        if (tokens.length) element.setAttribute(name, tokens.join(" "));
        else element.removeAttribute(name);
        continue;
      }
      if (!ATTRIBUTES.get(key).test(value)) element.removeAttribute(name);
    }
  }

  /**
   * Strips a detached element tree in place: a DOM walk, never a regex over
   * markup. Returns the same element.
   */
  function strip(top) {
    cleanAttributes(top);
    const stack = [top];
    while (stack.length) {
      const parent = stack.pop();
      for (const node of [...parent.childNodes]) {
        if (node.nodeType === TEXT) {
          const length = node.data.trim().length;
          if (length) node.data = `[${length}]`;
          else parent.removeChild(node);
          continue;
        }
        // Comments, CDATA, processing instructions, doctypes.
        if (node.nodeType !== ELEMENT) {
          parent.removeChild(node);
          continue;
        }
        const tag = String(node.localName || node.nodeName).toLowerCase();
        if (DROP.has(tag)) {
          parent.removeChild(node);
          continue;
        }
        cleanAttributes(node);
        if (tag === "svg") {
          while (node.firstChild) node.removeChild(node.firstChild);
          continue;
        }
        stack.push(node);
      }
    }
    return top;
  }

  /**
   * A stripped copy of the whole document. The copy is made in an inert
   * document, so nothing in it loads or runs while it is being stripped.
   */
  function strippedDocument(doc) {
    const inert = doc.implementation?.createHTMLDocument?.("");
    const clone = inert ? inert.importNode(doc.documentElement, true) : doc.documentElement.cloneNode(true);
    return strip(clone);
  }

  async function gzipBase64(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  /**
   * `{ html }` (gzip, base64) for the whole document, else for its <body>
   * alone when the whole is over `maxChars`, else `{ tooLarge: true }`.
   */
  async function capture(doc, maxChars = MAX_CHARS) {
    const clone = strippedDocument(doc);
    const whole = await gzipBase64(`<!doctype html>${clone.outerHTML}`);
    if (whole.length <= maxChars) return { html: whole, scope: "document" };
    const body = [...clone.children].find(child => String(child.localName).toLowerCase() === "body");
    if (body) {
      const bodyOnly = await gzipBase64(body.outerHTML);
      if (bodyOnly.length <= maxChars) return { html: bodyOnly, scope: "body" };
    }
    return { tooLarge: true };
  }

  root.CmsPageSnapshot = { MAX_CHARS, strip, strippedDocument, gzipBase64, capture };
})(globalThis);

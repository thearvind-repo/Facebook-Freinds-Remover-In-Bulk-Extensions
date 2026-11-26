// Pure helpers for the Facebook friends page. Loaded as a plain content script
// before friends-page.js (content scripts cannot import modules) and evaluated
// directly by the unit tests, so nothing here may touch the DOM or chrome.*.
(root => {
  // Single-segment paths Facebook owns. None of them can be a vanity name, and
  // several sit in the profile header beside the friends list — the Dashboard
  // button links to /professional_dashboard/, which used to be read as a
  // profile and given an unfriend checkbox.
  const RESERVED = new Set([
    "", "about", "ad_center", "ads", "allactivity", "birthdays", "bookmarks",
    "business", "buying", "careers", "checkpoint", "community", "directory",
    "donate", "events", "friends", "friends_all", "fundraisers", "gaming",
    "groups", "hashtag", "help", "home.php", "jobs", "lite", "live", "local",
    "login", "marketplace", "me", "memories", "messages", "mobile",
    "notifications", "offers", "orders", "pages", "payments", "photo",
    "photo.php", "policies", "privacy", "professional_dashboard", "recover",
    "reel", "reels", "saved", "search", "security", "settings", "share",
    "stories", "support", "terms", "watch", "weather"
  ]);
  const FRIENDS_TABS = new Set(["friends", "friends_all"]);
  const FACEBOOK_HOST = /(^|\.)facebook\.com$/i;

  /** A profile link reduced to a stable key. Returns null for anything else. */
  function profileIdentity(href, origin = "https://www.facebook.com") {
    let url;
    try {
      url = new URL(href, origin);
    } catch {
      return null;
    }
    if (!FACEBOOK_HOST.test(url.hostname)) return null;
    if (url.pathname === "/profile.php") {
      const id = url.searchParams.get("id");
      // A profile.php link with its own tab (sk=photos) is a tab, not a card.
      if (!/^\d+$/.test(id || "") || url.searchParams.get("sk")) return null;
      return { key: `id:${id}`, id, url: `https://www.facebook.com/profile.php?id=${id}` };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === "people" && /^\d+$/.test(parts.at(-1) || "")) {
      const id = parts.at(-1);
      return { key: `id:${id}`, id, url: `https://www.facebook.com/profile.php?id=${id}` };
    }
    if (parts.length !== 1) return null;
    let slug;
    try {
      slug = decodeURIComponent(parts[0]).toLowerCase();
    } catch {
      return null;
    }
    if (RESERVED.has(slug) || slug.includes(".php")) return null;
    return /^\d+$/.test(slug)
      ? { key: `id:${slug}`, id: slug, url: `https://www.facebook.com/profile.php?id=${slug}` }
      : { key: `path:${slug}`, id: null, url: `https://www.facebook.com/${parts[0]}` };
  }

  // Profile tab names Facebook owns, safe to name in a report. A second path
  // segment outside this list may be anything (a post slug, a vanity), so it
  // is only counted, never named.
  const PROFILE_TABS = new Set([
    "about", "followers", "following", "friends", "friends_all", "friends_mutual", "friends_recent",
    "friends_with_unseen_posts", "groups", "likes", "map", "photos", "posts", "reels", "reviews",
    "videos", "events", "music", "movies", "sports", "books", "tv", "places"
  ]);

  /**
   * The shape of one link on the friends page, for the card-scan report: a
   * profile (`p`), a profile's own tab (`t`, profile.php?sk= or /vanity/tab),
   * another multi-segment path (`m`), one of Facebook's own routes (`r`), an
   * external host (`x`) or anything else (`o`). `name` is set only to a word
   * Facebook owns (a reserved route or a known tab), never to a person's slug.
   */
  function linkShape(href, origin = "https://www.facebook.com") {
    let url;
    try {
      url = new URL(href, origin);
    } catch {
      return { kind: "o", name: "" };
    }
    if (!/^https?:$/.test(url.protocol)) return { kind: "o", name: "" };
    if (!FACEBOOK_HOST.test(url.hostname)) return { kind: "x", name: "" };
    if (profileIdentity(url.href)) return { kind: "p", name: "" };
    const parts = url.pathname.split("/").filter(Boolean);
    let first = "";
    try { first = decodeURIComponent(parts[0] || "").toLowerCase(); } catch {}
    if (url.pathname === "/profile.php") {
      const tab = String(url.searchParams.get("sk") || "").toLowerCase();
      return { kind: "t", name: PROFILE_TABS.has(tab) ? tab : "" };
    }
    if (!parts.length) return { kind: "o", name: "" };
    if (RESERVED.has(first) || first.includes(".php")) {
      return { kind: "r", name: /^[a-z0-9_.]{1,24}$/.test(first) ? first : "" };
    }
    const second = String(parts[1] || "").toLowerCase();
    if (parts.length === 2 && PROFILE_TABS.has(second)) return { kind: "t", name: second };
    return { kind: "m", name: "" };
  }

  /**
   * Counts of link shapes plus the three most common Facebook-owned names,
   * as one short string: "p=0 t=4 m=12 r=20 x=1 o=3 top=friends_mutual:4,groups:2".
   * `extra` counts (pass, dlg) go before the names, so a 160-character cut
   * can only ever shorten the names.
   */
  function linkShapeSummary(hrefs = [], extra = {}) {
    const counts = { p: 0, t: 0, m: 0, r: 0, x: 0, o: 0 };
    const names = new Map();
    for (const href of hrefs) {
      const { kind, name } = linkShape(href);
      counts[kind] += 1;
      if (name) names.set(name, (names.get(name) || 0) + 1);
    }
    const top = [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
      .map(([name, count]) => `${name}:${count}`).join(",");
    return [...Object.entries(counts), ...Object.entries(extra)]
      .map(([kind, count]) => `${kind}=${count}`).join(" ") + (top ? ` top=${top}` : "");
  }

  /** "vanity/friends_all" or "profile.php?id=…&sk=friends". Returns a stable key or null. */
  function friendsPageKey(pathname, search = "") {
    if (pathname === "/profile.php") {
      const params = new URLSearchParams(search);
      const id = params.get("id");
      return /^\d+$/.test(id || "") && FRIENDS_TABS.has(params.get("sk") || "") ? `id:${id}` : null;
    }
    const parts = String(pathname || "").split("/").filter(Boolean);
    // Facebook uses both /vanity/friends_all and /vanity?sk=friends_all.
    const tab = parts.length === 2 ? parts[1] : parts.length === 1 ? new URLSearchParams(search).get("sk") : null;
    if (!tab || !FRIENDS_TABS.has(tab.toLowerCase())) return null;
    const owner = parts[0].toLowerCase();
    if (RESERVED.has(owner)) return null;
    return /^\d+$/.test(owner) ? `id:${owner}` : `path:${owner}`;
  }

  // sk=friends, not sk=friends_all: Facebook now redirects friends_all to
  // /<vanity>/friends_all/, which renders an empty Followers/Following shell,
  // while sk=friends lands on /<vanity>/friends/ with the cards (live,
  // 2026-11-16). Both tabs are still recognised by friendsPageKey.
  function friendsUrl(accountId) {
    return `https://www.facebook.com/profile.php?id=${encodeURIComponent(accountId)}&sk=friends`;
  }

  /**
   * The sk=friends form of a friends_all page ("/jane/friends_all/?sk=friends_all"
   * → "/jane/friends/?sk=friends"), as a path plus query, or null when the
   * page is not a friends_all page.
   */
  function friendsTabFallback(pathname, search = "") {
    if (!friendsPageKey(pathname, search)) return null;
    const params = new URLSearchParams(search);
    const parts = String(pathname || "").split("/");
    let changed = false;
    const path = parts.map(part => {
      if (part.toLowerCase() !== "friends_all") return part;
      changed = true;
      return "friends";
    }).join("/");
    if ((params.get("sk") || "").toLowerCase() === "friends_all") {
      params.set("sk", "friends");
      changed = true;
    }
    if (!changed) return null;
    const query = params.toString();
    return `${path}${query ? `?${query}` : ""}`;
  }

  /* ------------------------------------------------ Facebook's own menu */

  // The "Unfriend" row carries an inline person-with-a-cross icon; the cross's
  // path is the one part of Facebook's markup here that does not depend on the
  // interface language. Text is the second signal, for when the icon changes.
  const UNFRIEND_ICON = /L17\.06 16l1\.72 1\.72/;
  // Bidi and zero-width marks Facebook wraps around names and RTL labels, and
  // the German gender forms (Freund/in, Freund*in, Freund:in, Freund_in,
  // Freund(in)) folded to one spelling so each label is listed once.
  const normalizeLabel = value => String(value || "")
    .normalize("NFC")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/freund(?:[/*:_]in|\(in\))/g, "freund");
  const UNFRIEND_LABELS = [
    "unfriend", "remove friend", "видалити з друзів", "удалить из друзей", "als freund entfernen", "freund entfernen",
    "freundschaft beenden", "eliminar de mis amigos", "eliminar de amigos", "eliminar de la lista de amigos",
    "eliminar amigo", "retirer des amis", "retirer de la liste d'amis", "desfazer amizade", "desfazer a amizade",
    "remover amizade", "rimuovi dagli amici", "rimuovi amicizia", "usuń z grona znajomych", "usuń ze znajomych",
    "vriendschap verbreken", "arkadaşlıktan çıkar", "hủy kết bạn", "huỷ kết bạn", "hapus pertemanan",
    "batalkan pertemanan", "ta bort som vän", "fjern som ven", "fjern som venn", "poista kavereista",
    "odebrat z přátel", "odstrániť z priateľov", "ismerős törlése", "elimină din lista de prieteni",
    "премахни от приятели", "διαγραφή από φίλους", "הסר מרשימת החברים", "إلغاء الصداقة", "إزالة من الأصدقاء",
    "मित्र सूची से निकालें", "เลิกเป็นเพื่อน", "友達から削除", "友達を削除", "친구 끊기", "取消好友", "解除好友",
    "删除好友", "移除好友", "刪除朋友", "解除朋友關係"
  ].map(normalizeLabel);
  const UNFOLLOW_LABELS = [
    "unfollow", "скасувати стеження", "відписатися", "скасувати підписку", "отменить подписку", "отписаться",
    "nicht mehr folgen", "entfolgen", "dejar de seguir", "ne plus suivre", "se désabonner", "deixar de seguir",
    "non seguire più", "przestań obserwować", "niet meer volgen", "takibi bırak", "bỏ theo dõi",
    "berhenti mengikuti", "sluta följa", "stop med at følge", "slutt å følge", "lopeta seuraaminen",
    "přestat sledovat", "prestať sledovať", "követés leállítása", "nu mai urmări", "прекрати следването",
    "διακοπή παρακολούθησης", "הפסק לעקוב", "إلغاء المتابعة", "अनफ़ॉलो करें", "เลิกติดตาม", "フォローをやめる",
    "팔로우 취소", "取消关注", "取消追蹤"
  ].map(normalizeLabel);

  // A row's title is its first line: Facebook may add a second, descriptive
  // line under it ("Stop seeing posts but stay friends"), and that line can
  // name the other action, so only the title is ever matched. The title may
  // carry the friend's name before or after the words ("Unfriend Jane Doe").
  function titleOf(text) {
    return String(text || "").split(/\n/).map(normalizeLabel).find(Boolean) || "";
  }

  function titleNames(title, labels) {
    return labels.some(label => title === label || title.includes(label));
  }

  /**
   * What a row of Facebook's friend menu does, from its text and its icon
   * paths. Only the two actions this tool takes are named; anything else is
   * null, so an unrecognised row is never clicked.
   */
  function classifyMenuItem({ text = "", iconPaths = [] } = {}) {
    if (iconPaths.some(path => UNFRIEND_ICON.test(String(path)))) return "unfriend";
    const title = titleOf(text);
    if (!title) return null;
    if (titleNames(title, UNFRIEND_LABELS)) return "unfriend";
    if (titleNames(title, UNFOLLOW_LABELS)) return "unfollow";
    return null;
  }

  /**
   * A short, label-free fingerprint of one menu row for crash reports: its
   * line count, whether its icon is an SVG path or a sprite, and the title's
   * length. Enough to tell "name appended" from "new wording" from "new icon".
   */
  function menuRowShape({ text = "", hasSvg = false, hasSprite = false } = {}) {
    const lines = String(text || "").split(/\n/).filter(line => line.trim()).length;
    return `l${lines}${hasSvg ? "s" : ""}${hasSprite ? "i" : ""}t${titleOf(text).length}`;
  }

  /** A short hash of an icon's geometry, never its label. */
  function iconHash(d) {
    if (!d) return "-";
    let hash = 0;
    for (let index = 0; index < d.length; index += 1) hash = (hash * 31 + d.charCodeAt(index)) >>> 0;
    return hash.toString(36).slice(0, 5);
  }

  const CONFIRM_LABELS = new Set([
    "confirm", "підтвердити", "подтвердить", "bestätigen", "confirmar", "confirmer", "conferma", "potwierdź",
    "bevestigen", "onayla", "xác nhận", "konfirmasi", "bekräfta", "bekræft", "bekreft", "vahvista", "potvrdit",
    "potvrdiť", "megerősítés", "confirmă", "потвърждаване", "επιβεβαίωση", "אישור", "تأكيد", "पुष्टि करें",
    "確認", "확인", "确认", "unfriend", "remove"
  ]);
  const DISMISS_LABELS = new Set([
    "cancel", "close", "скасувати", "закрити", "отмена", "закрыть", "abbrechen", "schließen", "cancelar",
    "cerrar", "annuler", "fermer", "annulla", "chiudi", "anuluj", "zamknij", "annuleren", "sluiten", "iptal",
    "kapat", "hủy", "đóng", "batal", "tutup", "avbryt", "stäng", "annuller", "luk", "lukk", "peruuta", "sulje",
    "zrušit", "zavřít", "zrušiť", "zavrieť", "mégse", "bezárás", "anulează", "închide", "отказ", "затваряне",
    "ακύρωση", "κλείσιμο", "ביטול", "סגירה", "إلغاء", "إغلاق", "रद्द करें", "बंद करें", "キャンセル", "閉じる",
    "취소", "닫기", "取消", "关闭", "關閉"
  ]);

  /**
   * Which button of Facebook's confirmation dialog confirms. The dialog is a
   * text-less Close (aria-label only) in the header, then the footer's Confirm
   * and Cancel, in that order, in every language and direction. A recognised
   * confirm label wins; otherwise the first button with visible text that is
   * not a recognised Cancel or Close. The caller verifies the outcome against
   * Facebook's own response either way. -1 when nothing qualifies.
   */
  function pickConfirmButton(buttons = []) {
    const labels = buttons.map(button => [normalizeLabel(button.label), normalizeLabel(button.text)]);
    const named = labels.findIndex(pair => pair.some(label => CONFIRM_LABELS.has(label)));
    if (named !== -1) return named;
    return labels.findIndex(([label, text]) => text && !DISMISS_LABELS.has(text) && !DISMISS_LABELS.has(label));
  }

  /**
   * The order to try a card's buttons in, as indexes into `buttons`. Each is
   * { label, text, popup, expanded, icon } for a visible button outside any
   * link. Facebook names the person in the label of their own "…" button
   * ("More options for Jane Doe") in every language, so a popup button that
   * names them comes first: it is never the friends-list header's own "…",
   * which an over-wide card used to reach. Then any popup button, then one
   * that only reports aria-expanded, then an icon-only labelled button. A
   * plain text button such as "Add friend" or "Message" is never a candidate.
   */
  function rankMenuButtons(buttons = [], name = "") {
    const person = normalizeLabel(name);
    const ranked = [];
    const take = test => buttons.forEach((button, index) => {
      if (!ranked.includes(index) && test(button)) ranked.push(index);
    });
    const names = button => person.length > 1 && normalizeLabel(button.label).includes(person);
    take(button => button.popup && names(button));
    take(button => button.popup);
    take(button => button.expanded);
    take(button => button.label && !String(button.text || "").trim() && button.icon);
    return ranked;
  }

  // Row icons (iconHash) of the menus Facebook opens on a card that is not a
  // friend — a followed Page or person, or someone else's friend. Seen in
  // every interface language in v66.3 reports (2026-10), never beside an
  // Unfriend or Unfollow row.
  const NOT_FRIEND_MENU_ICONS = new Set(["13ta2", "1gn7t", "1wu12"]);

  /**
   * Whether a menu without Unfriend or Unfollow belongs to someone who is not
   * a friend, so the card is skipped rather than treated as a broken page.
   * A friend's menu always has at least three rows (lists, Unfollow,
   * Unfriend); one or two rows, or a known non-friend icon, is another menu.
   */
  function isNotFriendMenu({ itemCount = 0, menuIcons = "" } = {}) {
    if (itemCount > 0 && itemCount <= 2) return true;
    return String(menuIcons).split(".").some(hash => NOT_FRIEND_MENU_ICONS.has(hash));
  }

  /**
   * The id of the profile whose page this is, from the JSON Facebook ships in
   * the HTML, or null when it is not there. A vanity page is matched by its
   * own vanity, so data left over from an earlier page cannot answer for it.
   */
  function pageOwnerId(scriptText, pageKey) {
    if (!pageKey) return null;
    if (pageKey.startsWith("id:")) return pageKey.slice(3);
    const vanity = pageKey.slice(5);
    const pairs = /"userID":"(\d+)","userVanity":"([^"]+)"/g;
    for (const [, id, slug] of String(scriptText || "").matchAll(pairs)) {
      if (slug.toLowerCase() === vanity) return id;
    }
    return null;
  }

  const LAYOUT_FAILURES = new Set(["ui_card_missing", "ui_menu_button_missing", "ui_menu_not_opened"]);
  const WORDING_FAILURES = new Set(["ui_no_menu_action", "ui_confirm_missing"]);

  /**
   * Why a menu-driven removal failed, as far as the user can do anything
   * about it: "not_friend" when the card's menu is one Facebook shows for
   * someone who is not a friend (skip them), "language" when Facebook's words
   * were not recognised on a non-English Facebook (switching to English fixes
   * it), "layout" when the page did not behave as expected (language would
   * not help), or null for everything else (no response, a refusal, a throttle).
   */
  function uiFailureKind(reason, pageLanguage = "", menu = {}) {
    if (reason === "ui_not_friend") return "not_friend";
    if (reason === "ui_no_menu_action" && isNotFriendMenu(menu)) return "not_friend";
    if (LAYOUT_FAILURES.has(reason)) return "layout";
    if (!WORDING_FAILURES.has(reason)) return null;
    return /^en\b/i.test(String(pageLanguage).trim()) ? "layout" : "language";
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function buildCsv(header, rows) {
    return `﻿${[header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  }

  /* ------------------------------------------------ page layout snapshot */

  // The route a layout snapshot was taken on, from the fixed list the
  // page-snapshot endpoint accepts. Never a slug, an id or a path.
  const SNAPSHOT_TABS = new Set(["friends", "friends_all", "followers", "following", "about"]);

  function snapshotRoute(pathname, search = "") {
    const parts = String(pathname || "").split("/").filter(Boolean);
    let first = "";
    try { first = decodeURIComponent(parts[0] || "").toLowerCase(); } catch { return "other"; }
    if (!parts.length || first === "home.php") return "home";
    if (first === "login" || first === "login.php") return "login";
    if (first === "checkpoint") return "checkpoint";
    const sk = String(new URLSearchParams(search).get("sk") || "").toLowerCase();
    if (first === "profile.php") return SNAPSHOT_TABS.has(sk) ? sk : sk ? "other" : "profile";
    if (RESERVED.has(first) || first.includes(".php")) return "other";
    if (parts.length === 1) return SNAPSHOT_TABS.has(sk) ? sk : sk ? "other" : "profile";
    const tab = String(parts[1] || "").toLowerCase();
    return parts.length === 2 && SNAPSHOT_TABS.has(tab) ? tab : "other";
  }

  root.CmsFriendsCore = {
    profileIdentity, linkShape, linkShapeSummary, friendsPageKey, friendsUrl, friendsTabFallback, classifyMenuItem, menuRowShape, iconHash,
    pickConfirmButton, rankMenuButtons, isNotFriendMenu, pageOwnerId, uiFailureKind, buildCsv, snapshotRoute
  };
})(globalThis);

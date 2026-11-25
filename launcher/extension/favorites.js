"use strict";
// ProjectX: избранные (закреплённые) чаты на странице сообщений FunPay.
// Звёздочка на аватаре чата (видна при наведении) закрепляет/открепляет его.
// Закреплённые чаты идут отдельной колонкой «Избранные» слева от списка FunPay.
// Список хранится в chrome.storage.local (ключ chatFavorites), как остальные настройки расширения.
(() => {
  if (window.__projectxFavorites) return;
  window.__projectxFavorites = true;

  const STORAGE_KEY = "chatFavorites";
  const MAX_FAVORITES = 100;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const STAR_PATH = "M12 2.8l2.82 5.72 6.31.92-4.57 4.45 1.08 6.29L12 17.21l-5.64 2.97 1.08-6.29L2.87 9.44l6.31-.92z";

  let favorites = [];        // [{ id, name, avatar }] в порядке закрепления (новые сверху)
  let loaded = false;
  let panel = null;
  let renderedKey = "";
  let frame;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const validId = id => /^\d{1,20}$/.test(String(id || ""));
  const isFavorite = id => favorites.some(item => item.id === id);

  function sanitize(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const result = [];
    for (const item of list) {
      const id = String(item?.id || "");
      if (!validId(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, name: String(item.name || "").slice(0, 80), avatar: safeUrl(item.avatar) });
      if (result.length >= MAX_FAVORITES) break;
    }
    return result;
  }

  function safeUrl(value) {
    let url = String(value || "").trim();
    if (url.startsWith("//")) url = "https:" + url;
    return /^(https:\/\/|\/(?!\/))[^\s"'()\\]+$/.test(url) ? url : "";
  }

  function save(list) {
    favorites = sanitize(list);
    schedule();
    chrome.storage.local.set({ [STORAGE_KEY]: favorites }).catch(error => console.warn("ProjectX favorites: save failed", error));
  }

  // ---------- данные из штатного списка чатов ----------
  function contactItems() {
    return $$(".chat-full .contact-list a.contact-item[data-id], .chat-full .chat-contacts a.contact-item[data-id]")
      .filter((item, index, all) => all.indexOf(item) === index && validId(item.dataset.id));
  }

  function readContact(item) {
    // Аватар — inline background-image у .avatar-photo внутри .contact-item-photo.
    // querySelector со списком селекторов вернул бы сам контейнер (он раньше в DOM), а у него url нет.
    const photo = $(".contact-item-photo .avatar-photo", item) || $(".contact-item-photo [style*='url']", item);
    const inline = /url\((['"]?)(.*?)\1\)/.exec(photo?.getAttribute("style") || "")?.[2] || "";
    const computed = photo ? /url\("?(.*?)"?\)/.exec(getComputedStyle(photo).backgroundImage)?.[1] || "" : "";
    const avatar = inline || computed;
    return {
      id: item.dataset.id,
      name: ($(".media-user-name", item)?.textContent || "").trim(),
      message: ($(".contact-item-message", item)?.textContent || "").trim().replace(/^[⁡⁤]/, ""),
      time: ($(".contact-item-time", item)?.textContent || "").trim(),
      avatar: safeUrl(avatar),
      unread: item.classList.contains("unread"),
      active: item.classList.contains("active"),
    };
  }

  function currentNode() {
    return new URLSearchParams(location.search).get("node") || "";
  }

  // ---------- звёздочка ----------
  function starIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", STAR_PATH);
    svg.append(path);
    return svg;
  }

  function makeStar(id) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "px-fav-star";
    button.dataset.pxFavId = id;
    button.append(starIcon());
    // Кнопка лежит внутри <a class="contact-item">: гасим переход в чат и делегированные обработчики FunPay.
    for (const type of ["mousedown", "mouseup", "pointerdown", "touchstart"]) {
      button.addEventListener(type, event => event.stopPropagation());
    }
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      toggle(id);
    });
    return button;
  }

  function paintStar(button) {
    const on = isFavorite(button.dataset.pxFavId);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    const label = on ? "Убрать из избранных" : "Добавить в избранные";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function toggle(id) {
    if (!loaded || !validId(id)) return;
    if (isFavorite(id)) {
      save(favorites.filter(item => item.id !== id));
      return;
    }
    const live = contactItems().find(item => item.dataset.id === id);
    const data = live ? readContact(live) : { name: "", avatar: "" };
    save([{ id, name: data.name, avatar: data.avatar }, ...favorites]);
  }

  function decorateContacts(items) {
    for (const item of items) {
      let star = $(":scope > .px-fav-star", item);
      if (!star || star.dataset.pxFavId !== item.dataset.id) {
        star?.remove();
        star = makeStar(item.dataset.id);
        item.append(star);
      }
      paintStar(star);
      item.classList.toggle("px-fav-marked", isFavorite(item.dataset.id));
    }
  }

  // ---------- колонка «Избранные» ----------
  function ensurePanel(chatFull) {
    if (panel?.isConnected && panel.parentElement === chatFull) return panel;
    panel?.remove();
    panel = document.createElement("aside");
    panel.className = "px-favs";
    panel.setAttribute("aria-label", "Избранные чаты");
    const header = document.createElement("div");
    header.className = "px-favs-header";
    const title = document.createElement("span");
    title.className = "px-favs-title";
    title.append(starIcon(), document.createTextNode("Избранные"));
    const count = document.createElement("span");
    count.className = "px-favs-count";
    header.append(title, count);
    const list = document.createElement("div");
    list.className = "px-favs-list custom-scroll";
    panel.append(header, list);
    chatFull.prepend(panel);
    renderedKey = "";
    return panel;
  }

  function openChat(event, id) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const original = contactItems().find(item => item.dataset.id === id);
    if (!original) return; // чата нет в последних — обычный переход по ссылке
    event.preventDefault();
    original.click();      // штатный обработчик FunPay открывает чат без перезагрузки
  }

  function buildRow(data) {
    const row = document.createElement("a");
    row.className = "px-fav-item";
    row.href = "/chat/?node=" + data.id;
    row.dataset.id = data.id;
    row.classList.toggle("unread", data.unread);
    row.classList.toggle("active", data.active);
    row.classList.toggle("px-fav-missing", !data.live);

    const avatar = document.createElement("span");
    avatar.className = "px-fav-avatar";
    if (data.avatar) avatar.style.backgroundImage = "url(" + JSON.stringify(data.avatar) + ")";
    else avatar.textContent = (data.name || "#").slice(0, 1).toUpperCase();

    const body = document.createElement("span");
    body.className = "px-fav-body";
    const name = document.createElement("span");
    name.className = "px-fav-name";
    name.textContent = data.name || "Чат #" + data.id;
    const message = document.createElement("span");
    message.className = "px-fav-message";
    message.textContent = data.live ? data.message : "Нет в последних чатах";
    body.append(name, message);

    const time = document.createElement("span");
    time.className = "px-fav-time";
    time.textContent = data.time || "";

    const star = makeStar(data.id);
    paintStar(star);
    row.append(avatar, body, time, star);
    row.addEventListener("click", event => openChat(event, data.id));
    return row;
  }

  function renderPanel(chatFull, live) {
    const root = document.documentElement;
    const show = loaded && favorites.length > 0;
    root.toggleAttribute("data-px-favs", show);
    if (!show) {
      panel?.remove();
      panel = null;
      renderedKey = "";
      return;
    }
    const node = currentNode();
    const rows = favorites.map(item => {
      const contact = live.get(item.id);
      return {
        id: item.id,
        live: Boolean(contact),
        name: contact?.name || item.name,
        avatar: contact?.avatar || item.avatar,
        message: contact?.message || "",
        time: contact?.time || "",
        unread: Boolean(contact?.unread),
        active: Boolean(contact?.active) || item.id === node,
      };
    });
    ensurePanel(chatFull);
    const key = JSON.stringify(rows);
    if (key === renderedKey) return;
    renderedKey = key;
    const list = $(".px-favs-list", panel);
    const scroll = list.scrollTop;
    list.replaceChildren(...rows.map(buildRow));
    list.scrollTop = scroll;
    const unread = rows.filter(row => row.unread).length;
    $(".px-favs-count", panel).textContent = unread ? unread + " / " + rows.length : String(rows.length);
  }

  // Подтягиваем свежие ник и аватар закреплённых чатов, чтобы колонка не устаревала.
  function refreshStored(live) {
    let changed = false;
    const next = favorites.map(item => {
      const contact = live.get(item.id);
      if (!contact) return item;
      const name = contact.name || item.name;
      const avatar = contact.avatar || item.avatar;
      if (name === item.name && avatar === item.avatar) return item;
      changed = true;
      return { ...item, name, avatar };
    });
    if (changed) save(next);
  }

  function update() {
    frame = undefined;
    const chatFull = $(".chat-full");
    if (!chatFull) {
      document.documentElement.removeAttribute("data-px-favs");
      return;
    }
    const items = contactItems();
    const live = new Map(items.map(item => [item.dataset.id, readContact(item)]));
    decorateContacts(items);
    if (!loaded) return;
    refreshStored(live);
    renderPanel(chatFull, live);
  }

  function schedule() {
    if (frame === undefined) frame = requestAnimationFrame(update);
  }

  // ---------- запуск ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    favorites = sanitize(changes[STORAGE_KEY].newValue);
    loaded = true;
    schedule();
  });

  function start() {
    if (!/^\/(?:[a-z]{2}\/)?chat\/?$/.test(location.pathname)) return;
    chrome.storage.local.get(STORAGE_KEY).then(settings => {
      favorites = sanitize(settings[STORAGE_KEY]);
      loaded = true;
      schedule();
    }, error => console.warn("ProjectX favorites: load failed", error));

    new MutationObserver(records => {
      // Свои изменения в колонке не должны перезапускать отрисовку.
      if (records.every(record => panel && panel.contains(record.target))) return;
      schedule();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    // FunPay переключает чаты через history API — подсветка активного чата идёт от ?node=.
    window.addEventListener("popstate", schedule);
    schedule();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

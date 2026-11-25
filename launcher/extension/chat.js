(async () => {
  "use strict";

  const wallpaperKey = "chatWallpaper";
  const themeKey = "chatTheme";
  const wallpapers = [
    ["01", "Янтарная долина"],
    ["02", "Туманная обсерватория"],
    ["03", "Затерянный мост"],
    ["04", "Медный каньон"],
    ["05", "Пагода над облаками"],
    ["06", "Ночь над фьордом"],
    ["07", "Забытый маяк"],
    ["08", "Долина углей"],
    ["09", "Лунный перевал"],
    ["10", "Озеро в осеннем лесу"],
  ];
  const presets = [
    ["violet", "Neon Purple", "#B873FF", "#14101C", "#21172C"],
    ["graphite", "Графит", "#CFD1DD", "#15151A", "#25252C"],
    ["midnight", "Полночь", "#86BAFF", "#0D1426", "#182540"],
  ];
  const palettes = [
    ["red", "Exploit", "#D54141"],
    ["jade", "Нефрит", "#A8DBB7"],
    ["ice", "Лёд", "#A0C8FF"],
    ["amethyst", "Аметист", "#D1B4FF"],
    ["amber", "Янтарь", "#F0C38D"],
    ["graphite-accent", "Графит", "#C9CCD0"],
    ["ruby", "Рубин", "#FF808E"],
    ["aqua", "Аква", "#60E4E6"],
    ["cobalt", "Кобальт", "#7898FF"],
    ["lime", "Лайм", "#C1ED74"],
    ["peach", "Персик", "#FFA982"],
    ["orchid", "Орхидея", "#F399DE"],
    ["gold", "Золото", "#FFD358"],
  ];
  const themes = new Map([...presets, ...palettes].map(([id, ...style]) => [id, style]));
  const resource = path => chrome.runtime.getURL(path);
  const wallpaperUrl = id => resource("backgrounds/" + id + ".jpg");
  const options = { [wallpaperKey]: new Map(), [themeKey]: new Map() };
  // У распакованного расширения после переноса меняется ID и хранилище настроек.
  const launcher = /(?:Electron|FunPayXLauncher)\//.test(navigator.userAgent);
  const preferences = { [wallpaperKey]: launcher ? "02" : "", [themeKey]: launcher ? "violet" : "" };
  const root = document.documentElement;
  if (!root) return;

  const isSupport = location.hostname === "support.funpay.com";
  const cacheKey = "projectx:appearance:v1";
  const keys = Object.keys(preferences);
  const receivedChanges = new Set();
  let synchronized = false;
  let preloadedWallpaper;
  let updateOptions;

  function readPreference(key, value) {
    const valid = key === wallpaperKey
      ? wallpapers.some(([id]) => id === value)
      : themes.has(value);
    preferences[key] = valid ? value : "";
  }

  function applyAppearance() {
    const wallpaper = preferences[wallpaperKey];
    const theme = preferences[themeKey];
    const [, accent, base, raised] = themes.get(theme) || presets[0].slice(1);
    root.style.setProperty("--projectx-accent", accent);
    root.style.setProperty("--projectx-base", base || "#15151A");
    root.style.setProperty("--projectx-raised", raised || "#25252C");
    root.toggleAttribute("data-projectx-themed", Boolean(wallpaper || theme));
    root.toggleAttribute("data-projectx-wallpaper", Boolean(wallpaper));
    if (wallpaper) {
      const url = wallpaperUrl(wallpaper);
      if (preloadedWallpaper?.src !== url) {
        preloadedWallpaper = new Image();
        preloadedWallpaper.fetchPriority = "high";
        preloadedWallpaper.src = url;
        preloadedWallpaper.decode().catch(() => {});
      }
      root.style.setProperty("--projectx-wallpaper", 'url("' + url + '")');
    } else {
      preloadedWallpaper = undefined;
      root.style.removeProperty("--projectx-wallpaper");
    }
    updateOptions?.();
  }

  function rememberAppearance() {
    try {
      const serialized = JSON.stringify(preferences);
      if (localStorage.getItem(cacheKey) !== serialized) localStorage.setItem(cacheKey, serialized);
    } catch {
      // Site storage can be unavailable. Extension storage remains authoritative.
    }
  }

  try {
    const snapshot = localStorage.getItem(cacheKey);
    if (snapshot && snapshot.length <= 128) {
      const cached = JSON.parse(snapshot);
      for (const key of keys) {
        if (!launcher || cached?.[key]) readPreference(key, cached?.[key]);
      }
    }
  } catch {
    // Fall back to extension storage if the cache is missing or unreadable.
  }
  root.toggleAttribute("data-projectx-support", isSupport);
  root.toggleAttribute("data-projectx-sales", !isSupport && /^\/(?:[a-z]{2}\/)?orders\/trade\/?$/.test(location.pathname));
  applyAppearance();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of keys) {
      if (!changes[key]) continue;
      receivedChanges.add(key);
      readPreference(key, changes[key].newValue);
    }
    applyAppearance();
    if (synchronized) rememberAppearance();
  });
  const settingsLoaded = chrome.storage.local.get(keys).then(settings => {
    for (const key of keys) {
      if (!receivedChanges.has(key) && Object.hasOwn(settings, key)) readPreference(key, settings[key]);
    }
    synchronized = true;
    applyAppearance();
    rememberAppearance();
    return true;
  }, () => false);

  if (document.readyState === "loading") {
    await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  if (document.querySelector(".projectx-settings")) return;

  const supportHeader = isSupport ? document.querySelector("#header, header, .navbar, body > nav") : null;
  const supportAccountSelector = '[href*="/users/"], .account-menu, .user-menu, .navbar-user, :is(a, button, [data-bs-toggle="dropdown"]):not(.navbar-brand):has(img)';
  const nav = document.querySelector("#header .navbar-right, .navbar .navbar-right")
    || supportHeader?.querySelector(".navbar-nav.ms-auto, .navbar-nav.ml-auto");

  const item = document.createElement(["UL", "OL"].includes(nav?.tagName) ? "li" : "span");
  item.className = "projectx-nav-item";
  const trigger = document.createElement("a");
  trigger.href = "#projectx-settings";
  trigger.className = "projectx-nav-button";
  trigger.textContent = isSupport ? "⚙" : "ProjectX";
  if (isSupport) trigger.setAttribute("aria-label", "Настройки оформления");
  trigger.setAttribute("role", "button");
  trigger.setAttribute("aria-haspopup", "dialog");
  item.append(trigger);

  function placeNavItem() {
    const oldLink = [...nav.querySelectorAll(":scope > li > :is(a, button), :scope > a, :scope > button")]
      .find(control => /^fp\s*tools$/i.test(control.textContent.trim()));
    if (oldLink) {
      const oldItem = oldLink.closest("li") || oldLink;
      oldItem.classList.add("projectx-replaced-nav-item");
      if (item.nextElementSibling !== oldItem) oldItem.before(item);
      return;
    }
    const profile = isSupport && [...nav.querySelectorAll(supportAccountSelector)].at(-1);
    const profileItem = profile && profile.closest("li, .nav-item");
    if (profileItem?.parentElement === nav) {
      if (profileItem.nextElementSibling !== item) profileItem.after(item);
    } else if (item.parentNode !== nav) {
      nav.append(item);
    }
  }

  if (nav) {
    placeNavItem();
    new MutationObserver(placeNavItem).observe(nav, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  } else if (isSupport) {
    const account = [...(supportHeader?.querySelectorAll(supportAccountSelector) || [])].at(-1);
    trigger.classList.add("projectx-support-shortcut");
    if (account) {
      account.after(trigger);
    } else {
      if (!supportHeader) trigger.classList.add("projectx-support-floating");
      (supportHeader || document.body).append(trigger);
    }
  }

  const dialog = document.createElement("dialog");
  dialog.className = "projectx-settings";
  dialog.setAttribute("aria-labelledby", "projectx-window-title");
  dialog.innerHTML = `
    <header class="projectx-titlebar">
      <img width="32" height="32" alt="">
      <span id="projectx-window-title">${isSupport ? "Настройки оформления" : "ProjectX"}</span>
      <div class="projectx-window-controls">
        <button type="button" class="projectx-expand" aria-label="Развернуть" title="Развернуть" aria-pressed="false">□</button>
        <button type="button" class="projectx-close" aria-label="Закрыть" title="Закрыть">×</button>
      </div>
    </header>
    <div class="projectx-settings-body">
      <nav class="projectx-settings-nav" aria-label="Разделы настроек">
        <button type="button" aria-controls="projectx-background-panel" aria-expanded="false" autofocus>
          <span class="projectx-icon projectx-icon-landscape" aria-hidden="true"></span>Фон
        </button>
        <button type="button" aria-controls="projectx-theme-panel" aria-expanded="false">
          <span class="projectx-icon projectx-icon-theme" aria-hidden="true"></span>Темы
        </button>
        <button type="button" aria-controls="projectx-commands-panel" aria-expanded="false">
          <span class="projectx-icon projectx-icon-commands" aria-hidden="true"></span>/команды
        </button>
        ${isSupport ? "" : '<button type="button" aria-controls="projectx-config-panel" aria-expanded="false">Перенос настроек</button>'}
      </nav>
      <div class="projectx-workspace">
        <section class="projectx-section" id="projectx-background-panel" hidden>
          <h2>Фон</h2>
          <div class="projectx-section-scroll">
            <button type="button" class="projectx-row projectx-clear">Без фона</button>
            <div class="projectx-wallpaper-grid"></div>
          </div>
        </section>
        <section class="projectx-section" id="projectx-theme-panel" hidden>
          <h2>Темы</h2>
          <div class="projectx-section-scroll">
            <div class="projectx-theme-presets"></div>
            <h3>Палитры</h3>
            <div class="projectx-theme-palettes"></div>
          </div>
        </section>
        <section class="projectx-section" id="projectx-commands-panel" hidden>
          <h2>/команды</h2>
          <div class="projectx-section-scroll">
            <p class="projectx-hint">Команды для поля чата и панели под ним. Работают в любом браузере с этим расширением. Команды из лаунчера подтягиваются сами и идут после этих. Переменные: $username, $order_id, $order_link, $date, $time.</p>
            <div class="projectx-commands-list"></div>
            <div class="projectx-commands-actions">
              <button type="button" class="projectx-row projectx-commands-add">+ Добавить команду</button>
              <button type="button" class="projectx-row projectx-commands-save">Сохранить</button>
            </div>
          </div>
        </section>
        <section class="projectx-section" id="projectx-config-panel" hidden>
          <h2>Перенос настроек</h2>
          <div class="projectx-section-scroll">
            <button type="button" class="projectx-row projectx-export">Скачать настройки и избранные чаты</button>
            <button type="button" class="projectx-row projectx-import">Загрузить настройки</button>
            <input type="file" accept=".json,application/json" class="projectx-import-file" hidden>
          </div>
        </section>
        <span class="projectx-status" role="status" hidden></span>
      </div>
    </div>
  `;
  dialog.querySelector(".projectx-titlebar img").src = resource("assets/projectx-icon.png");
  document.fonts.add(new FontFace("ProjectX UI", 'url("' + resource("assets/noto-sans-semibold.ttf") + '")', { weight: "600" }));
  document.body.append(dialog);

  const status = dialog.querySelector(".projectx-status");
  const sectionButtons = [...dialog.querySelectorAll(".projectx-settings-nav button")];

  function showSection(activeButton) {
    for (const button of sectionButtons) {
      const open = button === activeButton;
      button.setAttribute("aria-expanded", String(open));
      document.getElementById(button.getAttribute("aria-controls")).hidden = !open;
    }
  }

  updateOptions = () => {
    for (const [key, buttons] of Object.entries(options)) {
      for (const [id, button] of buttons) {
        button.setAttribute("aria-pressed", String(id === preferences[key]));
      }
    }
  };

  const pending = new Set();
  function registerOption(key, id, button) {
    options[key].set(id, button);
    button.addEventListener("click", async () => {
      if (pending.has(key) || preferences[key] === id) return;
      pending.add(key);
      status.hidden = true;
      try {
        await chrome.storage.local.set({ [key]: id });
      } catch {
        status.textContent = "Не удалось сохранить настройку.";
        status.hidden = false;
      } finally {
        pending.delete(key);
      }
    });
  }

  const grid = dialog.querySelector(".projectx-wallpaper-grid");
  registerOption(wallpaperKey, "", dialog.querySelector(".projectx-clear"));
  for (const [id, title] of wallpapers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "projectx-wallpaper-option";

    const picture = document.createElement("img");
    picture.alt = "";
    picture.loading = "lazy";
    picture.decoding = "async";
    picture.width = 1672;
    picture.height = 941;
    picture.src = wallpaperUrl(id);
    const label = document.createElement("span");
    label.textContent = id + " · " + title;
    button.append(picture, label);
    registerOption(wallpaperKey, id, button);
    grid.append(button);
  }

  function addThemeOptions(container, entries) {
    for (const [id, title, color] of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "projectx-row";
      const swatch = document.createElement("span");
      swatch.className = "projectx-swatch";
      swatch.style.setProperty("--projectx-swatch", color);
      button.append(swatch, title);
      registerOption(themeKey, id, button);
      container.append(button);
    }
  }

  addThemeOptions(dialog.querySelector(".projectx-theme-presets"), [
    ["", "Стандартная", "#C9CCD0"],
    ...presets,
  ]);
  addThemeOptions(dialog.querySelector(".projectx-theme-palettes"), palettes);

  // /команды, сохранённые в самом расширении (chrome.storage.local), а не в commands.json лаунчера.
  const commandsKey = "chatCommands";
  const configKeys = [...keys, commandsKey, "chatFavorites"];
  if (!isSupport) {
    const input = dialog.querySelector(".projectx-import-file");
    dialog.querySelector(".projectx-export").addEventListener("click", async () => {
      try {
        const config = await chrome.storage.local.get(configKeys);
        const url = URL.createObjectURL(new Blob([JSON.stringify({
          version: 1, ...preferences, ...config
        }, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "funpayx-settings.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        status.textContent = "Не удалось скачать настройки.";
        status.hidden = false;
      }
    });
    dialog.querySelector(".projectx-import").addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files[0];
      input.value = "";
      if (!file) return;
      try {
        if (file.size > 2_000_000) throw new Error("Config too large");
        const config = JSON.parse(await file.text());
        if (!config || typeof config !== "object" || Array.isArray(config) ||
            (config.version !== undefined && config.version !== 1)) throw new Error("Invalid config");
        const updates = Object.fromEntries(keys.filter(key => typeof config[key] === "string")
          .map(key => [key, config[key]]));
        if (Array.isArray(config[commandsKey])) {
          updates[commandsKey] = config[commandsKey].filter(item =>
            typeof item?.command === "string" && typeof item.response === "string").slice(0, 500);
        }
        if (Array.isArray(config.chatFavorites)) {
          const current = (await chrome.storage.local.get("chatFavorites")).chatFavorites;
          const favorites = new Map();
          for (const item of [...config.chatFavorites, ...(Array.isArray(current) ? current : [])]) {
            const id = String(item?.id ?? "");
            if (!/^\d{1,20}$/.test(id) || favorites.has(id)) continue;
            favorites.set(id, { id, name: String(item.name ?? "").slice(0, 80), avatar: String(item.avatar ?? "").slice(0, 2048) });
            if (favorites.size >= 100) break;
          }
          updates.chatFavorites = [...favorites.values()];
        }
        if (!Object.keys(updates).length) throw new Error("Empty config");
        await chrome.storage.local.set(updates);
        status.textContent = "Настройки загружены.";
      } catch {
        status.textContent = "Не удалось загрузить настройки. Проверьте файл JSON.";
      }
      status.hidden = false;
    });
  }
  const commandsList = dialog.querySelector(".projectx-commands-list");
  function addCommandRow(command = "", response = "") {
    const row = document.createElement("div");
    row.className = "projectx-command-row";
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "/1";
    name.maxLength = 40;
    name.value = command;
    name.setAttribute("aria-label", "Команда");
    const text = document.createElement("textarea");
    text.rows = 2;
    text.placeholder = "Текст ответа";
    text.value = response;
    text.setAttribute("aria-label", "Ответ");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "projectx-command-remove";
    remove.title = "Убрать команду";
    remove.setAttribute("aria-label", "Убрать команду");
    remove.textContent = "×";
    remove.addEventListener("click", () => row.remove());
    row.append(name, text, remove);
    commandsList.append(row);
    return row;
  }
  async function loadCommandRows() {
    commandsList.replaceChildren();
    try {
      const stored = (await chrome.storage.local.get(commandsKey))[commandsKey];
      for (const item of Array.isArray(stored) ? stored : []) addCommandRow(String(item?.command || ""), String(item?.response || ""));
    } catch {
      status.textContent = "Не удалось загрузить команды.";
      status.hidden = false;
    }
    if (!commandsList.children.length) addCommandRow();
  }
  dialog.querySelector(".projectx-commands-add").addEventListener("click", () => addCommandRow().querySelector("input").focus());
  dialog.querySelector(".projectx-commands-save").addEventListener("click", async () => {
    const list = [];
    const seen = new Set();
    for (const row of commandsList.children) {
      const command = row.querySelector("input").value.trim().toLowerCase().replace(/\s*\|\s*/g, "|");
      const response = row.querySelector("textarea").value.replace(/\r/g, "").trim();
      if (!command && !response) continue;
      if (!command || !response) { status.textContent = "У каждой команды должны быть имя и ответ."; status.hidden = false; return; }
      for (const part of command.split("|").filter(Boolean)) {
        if (seen.has(part)) { status.textContent = "Команда «" + part + "» указана дважды."; status.hidden = false; return; }
        seen.add(part);
      }
      list.push({ command, response });
    }
    try {
      await chrome.storage.local.set({ [commandsKey]: list.slice(0, 500) });
      status.textContent = "Команды сохранены: " + list.length + ".";
    } catch {
      status.textContent = "Не удалось сохранить команды.";
    }
    status.hidden = false;
  });
  sectionButtons.find(button => button.getAttribute("aria-controls") === "projectx-commands-panel")
    ?.addEventListener("click", loadCommandRows);
  for (const button of sectionButtons) {
    button.addEventListener("click", () => showSection(button));
  }

  function openSettings() {
    if (dialog.open) return;
    showSection(sectionButtons.find(button => button.getAttribute("aria-expanded") === "true") || sectionButtons[0]);
    dialog.showModal();
  }

  trigger.addEventListener("click", event => {
    event.preventDefault();
    openSettings();
  });
  trigger.addEventListener("keydown", event => {
    if (event.key !== " ") return;
    event.preventDefault();
    openSettings();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "projectx-open-settings") return;
    openSettings();
    respond(true);
  });
  function openFromHash() {
    if (location.hash !== "#projectx-settings") return;
    openSettings();
    history.replaceState(history.state, "", location.pathname + location.search);
  }
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
  dialog.querySelector(".projectx-close").addEventListener("click", () => dialog.close());
  const expand = dialog.querySelector(".projectx-expand");
  expand.addEventListener("click", () => {
    const expanded = dialog.classList.toggle("projectx-expanded");
    const label = expanded ? "Восстановить размер" : "Развернуть";
    expand.setAttribute("aria-label", label);
    expand.setAttribute("aria-pressed", String(expanded));
    expand.title = label;
    expand.textContent = expanded ? "❐" : "□";
  });

  updateOptions();
  if (!(await settingsLoaded)) {
    status.textContent = "Не удалось загрузить настройки.";
    status.hidden = false;
  }
})();

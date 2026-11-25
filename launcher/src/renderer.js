const $ = id => document.getElementById(id);
const api = window.cardinal;
const presets = [
  ['terminal','#39FF6A','Терминал'], ['violet','#B873FF','Неоновый фиолетовый'], ['rose','#F78FC9','Розовый'],
  ['mint','#73F0C6','Мята'], ['ice','#86BAFF','Ледяной синий'], ['amber','#FCC47B','Янтарь'], ['white','#CFD1DD','Серебро']
];
const themeAccents = { terminal:'#39FF6A', violet:'#B873FF', graphite:'#CFD1DD', midnight:'#86BAFF' };
const labels = { bot:'Бот', app:'Лаунчер', sound:'Звуки', look:'Оформление' };
const groups = {
  bot: [
    ['botDir','Папка бота','folder'],
    ['python','Python','python','авто: venv, py -3, python'],
    ['autorestart','Перезапускать бота после падения','toggle'],
    ['autostart','Запускать бота при открытии лаунчера','toggle']
  ],
  app: [
    ['tray','Сворачивать в трей (бот продолжает работать)','toggle'],
    ['profileInterval','Обновлять профиль FunPay каждые','range',5,120,' с'],
    ['translate','Переводить иностранные сообщения в чатах на русский (Google Переводчик)','toggle']
  ],
  sound: [
    ['sounds','Звуки уведомлений','toggle'],
    ['soundVolume','Громкость (больше 100% — усиление)','range',0,150,'%'],
    ['popups','Всплывающие уведомления справа снизу','toggle'],
    ['popupSeconds','Уведомление исчезает через','range',3,30,' с'],
    ['events','События','events'],
    ['soundCustomName','Свой звук (mp3, ogg, wav)','customfile'],
    ['muteSite','Глушить звук сайта FunPay, пока бот запущен','toggle']
  ],
  look: [
    ['theme','Встроенная тема','select',{terminal:'Терминал',violet:'Фиолетовый',graphite:'Графит',midnight:'Полночь'}],
    ['palette','Готовые акценты','palette'], ['accent','Свой акцент','color'],
    ['scale','Масштаб интерфейса','range',80,125,'%'], ['opacity','Прозрачность панелей','range',0,100,'%'],
    ['intensity','Интенсивность эффектов','range',0,100,'%'],
    ['glow','Свечение','toggle'], ['animations','Анимации','toggle'],
    ['background','Фон главного блока','select',{scan:'Строки развёртки',plain:'Однотонный'}]
  ]
};
let state, prefs, draft, status, plugins = [], catalog = [], values = {}, expanded = new Set(), pluginsChanged = false, logs = [], current = 'home', group = 'bot', level = 'all', consoleOpen = false;

const node = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value != null) element.textContent = value;
  if (className) element.className = className;
  return element;
};
async function call(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function toast(message, kind = 'info') {
  const entry = node('div', message, 'toast');
  entry.dataset.kind = kind;
  $('toasts').append(entry);
  while ($('toasts').childElementCount > 3) $('toasts').firstElementChild.remove();
  setTimeout(() => { entry.classList.add('leaving'); setTimeout(() => entry.remove(), 300); }, kind === 'error' ? 8000 : 3600);
}
const guard = fn => async (...args) => { try { await fn(...args); } catch (error) { toast(error.message, 'error'); } };

function theme(value) {
  const root = document.documentElement;
  const rgb = value.accent.match(/[0-9a-f]{2}/gi).map(hex => parseInt(hex, 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  const properties = {
    '--accent':value.accent, '--ink':.2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] > .18 ? '#120a1c' : '#fff',
    '--alpha':value.opacity / 100, '--ui':14 * value.scale / 100 + 'px',
    '--shine':value.glow ? value.intensity / 100 : 0, '--fx':value.intensity / 100
  };
  for (const [property, setting] of Object.entries(properties)) root.style.setProperty(property, setting);
  root.dataset.theme = value.theme;
  root.dataset.background = value.background;
  root.toggleAttribute('data-static', !value.animations);
}

function duration(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}д ${h}ч ${m}м` : h ? `${h}ч ${m}м` : `${m}м ${s % 60}с`;
}

// ---- главная: состояние и консоль ----
function renderStatus() {
  consoleIntro(status);
  const on = status.running, wait = !on && status.restartPending;
  $('start').disabled = on || !state.bot.hasMain;
  $('start').querySelector('span').textContent = wait ? 'Запустить сейчас' : 'Запустить бота';
  $('tb-status').textContent = on ? 'online' : wait ? 'restart' : 'offline';
  $('tb-status').classList.toggle('on', on);
  $('rail-dot').className = 'dot' + (on ? ' on' : wait ? ' wait' : '');
  $('rail-status').textContent = on ? 'Бот работает' : wait ? 'Ждёт перезапуска' : 'Бот остановлен';
  $('functions-banner').hidden = !on;
  $('plugins-banner').hidden = !(on && pluginsChanged);
  $('matrix-state').textContent = on ? 'running' : wait ? 'restarting' : 'stopped';
  // В остановленном состоянии кнопка в консоли запускает бота, чтобы не сворачивать консоль.
  $('stop').disabled = false;
  $('stop').textContent = on ? 'Стоп' : wait ? 'Отменить' : 'Запустить';
  $('stop').className = (on || wait ? 'danger' : 'primary') + ' small';
  if (!on && !wait) $('stop').disabled = !state.bot.hasMain;
  $('restart').disabled = !on;
  $('boot').textContent = [
    `[ ${state.bot.hasMain ? 'ok' : '!!'} ] ${state.bot.hasMain ? 'bot ' + (state.bot.version || '?') : 'main.py не найден'}`,
    `[ ${state.python ? 'ok' : '!!'} ] ${state.python ? 'python ' + state.python.version : 'python не найден'}`,
    `[ ${state.bot.hasConfig ? 'ok' : '!!'} ] ${state.bot.hasConfig ? 'configs/_main.cfg' : 'нужна первая настройка'}`,
    `[ ${on ? 'ok' : '..'} ] ${on ? 'bot online · pid ' + status.pid : 'awaiting start'}`
  ].join('\n');
  if (on && !consoleOpen) setConsole(true);
  tick();
}
function tick() {
  const text = status?.running && status.startedAt ? duration(Date.now() - status.startedAt) : '—';
  $('st-uptime').textContent = text;
  $('uptime').textContent = status?.running ? 'uptime ' + text : '';
}
setInterval(tick, 1000);

function setConsole(open) {
  consoleOpen = open;
  $('matrix').hidden = !open;
  $('home').classList.toggle('console-open', open);
  if (open) scrollConsole(true);
}
function lineClass(line) {
  if (line.stream === 'sys') return 'sys';
  if (line.stream === 'err' || /\bE: |\bC: |Traceback|Error/.test(line.text)) return 'err';
  if (/\bW: /.test(line.text)) return 'warn';
  return '';
}
function addLine(line) {
  const box = $('matrix-lines');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(node('div', line.text, lineClass(line)));
  while (box.childElementCount > 600) box.firstElementChild.remove();
  if (stick) scrollConsole(true);
}
function scrollConsole() { const box = $('matrix-lines'); box.scrollTop = box.scrollHeight; }

function renderEnvironment() {
  $('setup-banner').hidden = !state.bot.hasMain || state.bot.hasConfig;
  $('hero-sub').textContent = state.bot.hasMain
    ? 'Бот для продавцов FunPay'
    : `main.py не найден в ${state.prefs.botDir}. Укажите папку бота в настройках.`;
  $('env-version').textContent = state.bot.version || '—';
  $('env-python').textContent = state.python ? state.python.version : 'не найден';
  $('env-config').textContent = state.bot.hasConfig ? 'есть' : 'нет';
  const active = plugins.filter(plugin => plugin.enabled).length;
  $('env-plugins').textContent = plugins.length ? `${active} из ${plugins.length}` : '—';
  $('brand-version').textContent = 'v' + state.version;
}

// ---- плагины ----
async function loadPlugins() { plugins = await call(api.plugins()); renderPlugins(); renderEnvironment(); }
const reminderPanels = new Map();
function reminderPanel(plugin) {
  const panel = node('div', null, 'module-settings');
  panel.addEventListener('click', event => event.stopPropagation());
  panel.addEventListener('keydown', event => event.stopPropagation());
  const data = reminderPanels.get(plugin.file);
  const settings = node('button', data ? 'Скрыть настройки' : 'Настройки напоминаний', 'secondary small');
  settings.addEventListener('click', guard(async () => {
    if (reminderPanels.has(plugin.file)) reminderPanels.delete(plugin.file);
    else reminderPanels.set(plugin.file, await call(api.reminderSettings(plugin.file)));
    renderPlugins();
  }));
  panel.append(settings);
  for (const field of data?.fields || []) {
    const row = node('label', null, 'setting');
    const input = node('input');
    input.type = field.type === 'toggle' ? 'checkbox' : 'number';
    if (input.type === 'checkbox') input.checked = field.value;
    else { input.min = field.min; input.max = field.max; input.step = 1; input.value = field.value; }
    input.addEventListener('change', guard(async () => {
      try {
        reminderPanels.set(plugin.file, await call(api.setReminderSetting(plugin.file, field.key,
          input.type === 'checkbox' ? input.checked : input.value)));
      } finally { renderPlugins(); }
    }));
    row.append(node('span', field.name), input);
    panel.append(row);
  }
  return panel;
}

function renderPlugins() {
  const query = $('plugin-search').value.trim().toLowerCase();
  const visible = plugins.filter(plugin => [plugin.name, plugin.description, plugin.file].join(' ').toLowerCase().includes(query));
  $('plugins-banner').hidden = !(status?.running && pluginsChanged);
  $('plugin-list').replaceChildren(...(visible.length ? visible.map(plugin => {
    const card = node('article', null, 'card mod-card plugin clickable' + (plugin.enabled ? '' : ' disabled'));
    card.tabIndex = 0;
    const head = node('header');
    const title = node('div');
    title.append(node('h3', plugin.name), node('time', 'v' + plugin.version));
    const toggle = node('input', null, 'switch');
    toggle.type = 'checkbox'; toggle.role = 'switch'; toggle.checked = plugin.enabled;
    toggle.setAttribute('aria-label', plugin.name);
    toggle.tabIndex = -1;
    const flip = guard(async () => {
      try {
        plugins = await call(api.togglePlugin(plugin.file, !plugin.enabled));
        pluginsChanged = true;
        toast(`${plugin.name}: ${plugin.enabled ? 'выключен' : 'включён'}${status?.running ? '. Перезапустите бота, чтобы применить.' : ''}`);
      } finally { renderPlugins(); renderEnvironment(); }
    });
    toggle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); flip(); });
    card.addEventListener('click', flip);
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } });
    head.append(title, toggle);
    const meta = node('div', null, 'meta');
    meta.append(node('span', plugin.enabled ? 'включён' : 'выключен', 'tag ' + (plugin.enabled ? 'on' : 'off')), node('span', plugin.file, 'tag'));
    if (plugin.credits) meta.append(node('span', plugin.credits, 'tag'));
    card.append(head, node('p', plugin.description || 'Без описания.'), meta);
    if (plugin.file === 'buyer_reminders.py') card.append(reminderPanel(plugin));
    return card;
  }) : [node('p', plugins.length ? 'Ничего не найдено.' : 'В папке plugins нет плагинов.', 'hint')]));
}

// ---- логи ----
const levels = [['all','Все'], ['I','Info'], ['W','Warn'], ['E','Error'], ['D','Debug']];
function renderLevels() {
  $('log-levels').replaceChildren(...levels.map(([id, name]) => {
    const button = node('button', name);
    button.type = 'button'; button.setAttribute('aria-pressed', String(id === level));
    button.addEventListener('click', () => { level = id; renderLevels(); renderLogs(); });
    return button;
  }));
}
async function loadLogs() {
  const result = await call(api.logs());
  logs = result.entries;
  $('log-meta').textContent = `${result.file} · ${(result.size / 1048576).toFixed(1)} МБ · показаны последние ${logs.length} записей`;
  renderLogs();
}
function renderLogs() {
  const query = $('log-search').value.trim().toLowerCase();
  const rows = logs.filter(entry => (level === 'all' ? entry.level !== 'D' : level === 'E' ? 'EC'.includes(entry.level) : entry.level === level)
    && (!query || entry.text.toLowerCase().includes(query))).slice(-800);
  const list = $('log-list');
  list.replaceChildren(...rows.map(entry => {
    const row = node('div', null, 'log-row lvl-' + entry.level);
    const time = node('time', entry.time); time.title = entry.source;
    row.append(time, node('b', entry.level), node('span', entry.text));
    return row;
  }));
  if (!rows.length) list.append(node('p', 'Записей нет.', 'hint'));
  list.scrollTop = list.scrollHeight;
}

// ---- настройки ----
function renderControls() {
  $('settings-tabs').replaceChildren(...Object.entries(labels).map(([id, title]) => {
    const button = node('button', title);
    button.type = 'button'; button.setAttribute('aria-pressed', String(id === group));
    button.addEventListener('click', () => { group = id; renderControls(); });
    return button;
  }));
  const content = $('controls');
  content.replaceChildren();
  for (const [key, name, type, first, second, suffix] of groups[group]) {
    const row = node('div', null, 'field');
    const label = node('label', name); label.htmlFor = 'field-' + key;
    row.append(label);
    if (type === 'palette') {
      const swatches = node('div', null, 'swatches');
      for (const [id, hex, title] of presets) {
        const button = node('button', null, id);
        button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
        button.setAttribute('aria-pressed', String(draft.accent === hex));
        button.addEventListener('click', () => { draft.accent = hex; theme(draft); renderControls(); });
        swatches.append(button);
      }
      row.append(swatches); content.append(row); continue;
    }
    if (type === 'events') {
      row.className = 'events-block'; row.replaceChildren();
      const headRow = node('div', null, 'ev-row ev-head');
      headRow.append(node('span', 'Событие'), node('span', 'Окно'), node('span', 'Звук'), node('span', ''), node('span', ''));
      row.append(headRow);
      for (const [kind, title, soundKey] of EVENTS) {
        const line = node('div', null, 'ev-row');
        const pop = node('label', null, 'pop'); const box = node('input'); box.type = 'checkbox';
        box.checked = draft.popupKinds?.[kind] !== false;
        box.addEventListener('change', () => { draft.popupKinds = { ...draft.popupKinds, [kind]: box.checked }; });
        pop.append(box, document.createTextNode('показ'));
        const select = node('select'); select.setAttribute('aria-label', 'Звук: ' + title);
        for (const [id, name] of ProjectXSounds.list()) select.append(new Option(id === 'custom' && draft.soundCustomName ? 'Свой: ' + draft.soundCustomName : name, id));
        select.value = draft[soundKey];
        select.addEventListener('change', () => { draft[soundKey] = select.value; ProjectXSounds.play(select.value, draft.soundVolume); });
        const listen = node('button', '▶', 'secondary small'); listen.type = 'button'; listen.title = 'Прослушать звук';
        listen.addEventListener('click', () => ProjectXSounds.play(select.value, draft.soundVolume));
        const test = node('button', 'Тест', 'secondary small'); test.type = 'button'; test.title = 'Показать тестовое уведомление со звуком';
        test.addEventListener('click', guard(async () => { ProjectXSounds.play(select.value, draft.soundVolume); await call(api.testPopup(kind)); }));
        line.append(node('span', title), pop, select, listen, test);
        row.append(line);
      }
      content.append(row); continue;
    }
    if (type === 'sound') {
      const box = node('div', null, 'input-group');
      const select = node('select'); select.id = 'field-' + key;
      for (const [id, title] of ProjectXSounds.list()) select.append(new Option(id === 'custom' && draft.soundCustomName ? 'Свой: ' + draft.soundCustomName : title, id));
      select.value = draft[key];
      select.addEventListener('change', () => { draft[key] = select.value; ProjectXSounds.play(select.value, draft.soundVolume); });
      const test = node('button', '▶', 'secondary'); test.type = 'button'; test.title = 'Прослушать';
      test.addEventListener('click', () => ProjectXSounds.play(select.value, draft.soundVolume));
      box.append(select, test); row.append(box); content.append(row); continue;
    }
    if (type === 'customfile') {
      const box = node('div', null, 'input-group');
      const name = node('span', draft.soundCustomName || 'не выбран', 'hint sound-file');
      const pick = node('button', 'Выбрать файл', 'secondary'); pick.type = 'button';
      pick.addEventListener('click', guard(async () => {
        const picked = await call(api.chooseSound());
        if (!picked) return;
        ProjectXSounds.forgetCustom();
        prefs.soundCustomName = draft.soundCustomName = picked.name;
        toast('Свой звук сохранён. Выберите «Свой» у нужного события.');
        renderControls();
      }));
      box.append(name, pick); row.append(box); content.append(row); continue;
    }
    const field = node(type === 'select' ? 'select' : 'input');
    field.id = 'field-' + key;
    if (type === 'select') for (const [id, title] of Object.entries(first)) field.append(new Option(title, id));
    else field.type = type === 'toggle' ? 'checkbox' : ['folder', 'python'].includes(type) ? 'text' : type;
    if (type === 'toggle') { field.role = 'switch'; field.checked = draft[key]; }
    else {
      if (type === 'range') { field.min = first; field.max = second; }
      if (type === 'python') field.placeholder = first;
      field.value = draft[key];
    }
    const out = type === 'range' ? node('output', field.value + suffix) : null;
    if (key === 'soundVolume') field.addEventListener('change', () => ProjectXSounds.play(draft.soundMessage !== 'off' ? draft.soundMessage : 'chime', draft.soundVolume));
    field.addEventListener('input', () => {
      draft[key] = type === 'toggle' ? field.checked : type === 'range' ? Number(field.value) : field.value;
      if (key === 'theme') { draft.accent = themeAccents[field.value]; renderControls(); }
      if (out) out.value = field.value + suffix;
      if (group === 'look') theme(draft);
    });
    if (out || type === 'folder' || type === 'python') {
      const box = node('div', null, 'input-group');
      box.append(field);
      if (out) box.append(out);
      else {
        const browse = node('button', 'Выбрать', 'secondary'); browse.type = 'button';
        browse.addEventListener('click', guard(async () => {
          const picked = await call(type === 'folder' ? api.chooseBotDir() : api.choosePython());
          if (picked) field.value = draft[key] = type === 'python' && picked.includes(' ') ? `"${picked}"` : picked;
        }));
        box.append(browse);
      }
      row.append(box);
    } else row.append(field);
    content.append(row);
  }
}

// ---- профиль FunPay ----
let profile = null, profileErr = null;
function showProfile(next, error) {
  if (next) profile = next;
  profileErr = error || null;
  if (!profile) {
    $('pf-name').textContent = error ? 'Профиль недоступен' : 'Загрузка…';
    $('pf-status').textContent = error || '';
    $('pf-status').className = 'pf-status' + (error ? ' bad' : '');
    return;
  }
  {
    $('pf-name').textContent = profile.username;
    $('pf-name').title = 'ID ' + profile.id;
    $('pf-status').textContent = profile.banned ? 'заблокирован' : profile.online ? 'онлайн' : (profile.status || 'офлайн');
    $('pf-status').className = 'pf-status' + (profile.online ? ' on' : '') + (profile.banned ? ' bad' : '');
    $('pf-initial').textContent = profile.username.slice(0, 1).toUpperCase();
    $('pf-img').hidden = !profile.avatar;
    if (profile.avatar && $('pf-img').src !== profile.avatar) $('pf-img').src = profile.avatar;
    $('pf-rating').textContent = profile.rating ? '★ ' + profile.rating : '—';
    $('pf-reviews').textContent = profile.reviews ?? '—';
    $('pf-balance').textContent = prefs?.hideBalance ? '•••••' : (profile.balance || '0');
    $('pf-sales').textContent = profile.activeSales;
    $('pf-registered').textContent = profile.registered || '—';
    $('pf-open').disabled = false;
  }
  updatedLabel();
}
function updatedLabel() {
  if (!profile) return;
  const ago = Math.max(0, Math.round((Date.now() - profile.loadedAt) / 1000));
  $('pf-updated').textContent = (profileErr ? `Нет связи: ${profileErr} · ` : '') + `обновлено ${ago < 5 ? 'только что' : ago < 120 ? ago + ' с назад' : Math.round(ago / 60) + ' мин назад'}`;
  $('pf-updated').classList.toggle('bad', Boolean(profileErr));
}
setInterval(updatedLabel, 1000);
async function loadProfile(force) {
  $('pf-refresh').disabled = true;
  $('profile-card').classList.add('loading');
  try { const result = await call(api.profile(force)); showProfile(result.profile, result.error); }
  catch (error) { showProfile(null, error.message); }
  finally { $('pf-refresh').disabled = false; $('profile-card').classList.remove('loading'); }
}

// ---- функции (как в Telegram-меню, ПКМ раскрывает настройки) ----
async function loadFunctions() {
  const result = await call(api.functions());
  catalog = result.catalog; values = result.values;
  renderFunctions();
}
const fid = item => `${item.section}.${item.key}`;
async function saveFunction(item, value) {
  values = await call(api.setFunction(fid(item), value));
  renderFunctions();
}
function settingRow(item) {
  const row = node('label', null, 'setting');
  row.append(node('span', item.name + (item.suffix ? ` (${item.suffix})` : '')));
  if (item.type === 'toggle') {
    const box = node('input', null, 'switch');
    box.type = 'checkbox'; box.role = 'switch'; box.checked = values[fid(item)] === '1';
    box.addEventListener('change', guard(() => saveFunction(item, box.checked)));
    row.append(box);
  } else if (item.type === 'number') {
    const box = node('input');
    box.type = 'number'; box.min = item.min; box.max = item.max; box.value = values[fid(item)];
    box.addEventListener('change', guard(async () => { await saveFunction(item, box.value); toast('Сохранено'); }));
    row.append(box);
  } else {
    row.classList.add('wide');
    const area = node('textarea');
    area.rows = Math.min(6, Math.max(2, (values[fid(item)] || '').split('\n').length));
    area.value = values[fid(item)];
    area.placeholder = 'Пусто';
    area.addEventListener('change', guard(async () => { await saveFunction(item, area.value); toast('Текст сохранён'); }));
    row.append(area);
  }
  return row;
}
function renderFunctions() {
  $('function-list').replaceChildren(...catalog.map(({ category, modules }) => {
    const panel = node('section', null, 'card module-panel');
    panel.append(node('h2', category));
    for (const module of modules) {
      const on = module.toggle ? values[fid(module.toggle)] === '1' : null;
      const open = expanded.has(module.id);
      const box = node('div', null, 'module' + (on ? ' on' : '') + (open ? ' open' : '') + (module.settings ? ' has-settings' : ''));
      const head = node('div', null, 'module-head');
      head.tabIndex = 0;
      head.title = module.hint || '';
      const name = node('span', module.name, 'module-name');
      if (module.settings) name.append(node('i', open ? '▴' : '▾', 'caret'));
      head.append(name);
      if (module.toggle) { const state = node('span', on ? 'ON' : 'OFF', 'module-state'); head.append(state); }
      const toggleOpen = () => { if (!module.settings) return; open ? expanded.delete(module.id) : expanded.add(module.id); renderFunctions(); };
      const flip = guard(async () => {
        if (!module.toggle) return toggleOpen();
        await saveFunction(module.toggle, !on);
      });
      head.addEventListener('click', flip);
      head.addEventListener('contextmenu', event => { event.preventDefault(); toggleOpen(); });
      head.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') toggleOpen();
      });
      box.append(head);
      if (open && module.settings) {
        const settings = node('div', null, 'module-settings');
        settings.append(...module.settings.map(settingRow));
        box.append(settings);
      }
      panel.append(box);
    }
    return panel;
  }));
}

// ---- чаты: сайт FunPay внутри программы с расширением ProjectX ----
let siteView = null;
// Двойной клик по слову копирует его в буфер (на сайте FunPay и в самом лаунчере). В полях ввода не мешаем.
function copyWordSetup() {
  if (window.__pxCopyWord || document.documentElement.dataset.pxCopy) return; window.__pxCopyWord = true;
  document.documentElement.dataset.pxCopy = 'app';
  let tip;
  document.addEventListener('dblclick', event => {
    if (event.target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], button, a, select')) return;
    const text = String(window.getSelection()).trim();
    if (!text || text.length > 200) return;
    const done = () => {
      tip?.remove(); tip = document.createElement('div');
      tip.textContent = 'Скопировано: ' + (text.length > 40 ? text.slice(0, 39) + '…' : text);
      tip.style.cssText = 'position:fixed;z-index:2147483647;left:' + Math.min(event.clientX + 12, innerWidth - 260) + 'px;top:' + Math.max(event.clientY - 34, 6) + 'px;padding:5px 10px;border-radius:6px;background:#1a1326;color:#ece4f5;border:1px solid #b873ff66;font:12px/1.3 Segoe UI,sans-serif;pointer-events:none;box-shadow:0 4px 14px #0006;transition:opacity .4s';
      document.body.append(tip);
      const node = tip; setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 400); }, 900);
    };
    (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(done, () => { if (document.execCommand('copy')) done(); });
  });
}
const COPY_WORD = `(${copyWordSetup.toString()})();`;
const SITE_CSS = `footer, .footer, .cookie-notice { display:none !important; }`;
// Пока бот запущен, о новых сообщениях сообщает звук ProjectX, а звук сайта глушим, чтобы не было двойного.
function applySiteMute() {
  try { siteView?.setAudioMuted(Boolean(prefs?.muteSite && prefs?.sounds && status?.running)); } catch { /* webview ещё не готов */ }
}
const EVENTS = [
  ['message', 'Новое сообщение', 'soundMessage'], ['order', 'Новый заказ', 'soundOrder'], ['confirm', 'Подтверждение заказа', 'soundConfirm'],
  ['review', 'Новый отзыв', 'soundReview'], ['raise', 'Лоты подняты', 'soundRaise'], ['delivered', 'Товар выдан', 'soundDelivered'],
  ['error', 'Ошибка выдачи товара', 'soundError']
];
const SOUND_KEYS = Object.fromEntries(EVENTS.map(([kind, , key]) => [kind, key]));
// Скрытие баланса: в карточке профиля и на самом сайте FunPay.
const BALANCE_CSS = `.badge-balance, .balances-value, .balances-list, .user-balance, .menu-item-balance .badge { filter: blur(6px) !important; }`;
let balanceCssKey = null;
async function applyBalance() {
  const hidden = Boolean(prefs?.hideBalance);
  $('pf-eye').setAttribute('aria-pressed', String(hidden));
  $('pf-eye').title = hidden ? 'Показать баланс' : 'Скрыть баланс';
  $('pf-eye').textContent = hidden ? '◌' : '◉';
  if (profile) $('pf-balance').textContent = hidden ? '•••••' : (profile.balance || '0');
  if (!siteView) return;
  try {
    if (hidden && !balanceCssKey) balanceCssKey = await siteView.insertCSS(BALANCE_CSS);
    if (!hidden && balanceCssKey) { await siteView.removeInsertedCSS(balanceCssKey); balanceCssKey = null; }
  } catch { /* сайт ещё грузится */ }
}
let pendingSiteUrl = null, siteReady = false;
async function openSite() {
  if (siteView) return;
  try {
    const url = await call(api.funpayView());
    siteView = document.createElement('webview');
    siteView.setAttribute('partition', 'persist:funpay');
    siteView.setAttribute('src', url);
    siteView.className = 'site-view';
    siteView.addEventListener('dom-ready', () => {
      siteReady = true; translateCss = false; siteView.insertCSS(SITE_CSS); siteView.executeJavaScript(COPY_WORD).catch(() => {}); balanceCssKey = null; applyBalance(); applySiteMute(); $('site-note').textContent = '';
      if (pendingSiteUrl) { const next = pendingSiteUrl; pendingSiteUrl = null; siteView.loadURL(next); }
    });
    siteView.addEventListener('did-fail-load', event => { if (event.errorCode !== -3) $('site-note').textContent = 'FunPay не открылся: ' + event.errorDescription; });
    $('chat-site-slot').replaceChildren(siteView);
  } catch (error) { $('site-note').textContent = error.message; }
}
$('site-back').addEventListener('click', () => { if (siteView?.canGoBack()) siteView.goBack(); });
$('site-reload').addEventListener('click', () => siteView?.reload());
$('site-chats').addEventListener('click', () => siteView?.loadURL('https://funpay.com/chat/'));
$('site-home').addEventListener('click', () => siteView?.loadURL('https://funpay.com/'));
$('site-support').addEventListener('click', () => siteView?.loadURL('https://support.funpay.com/'));
$('site-settings').addEventListener('click', () => {
  if (!siteView) return;
  // Расширение открывает свои настройки по адресу с #projectx-settings.
  siteView.executeJavaScript("document.querySelector('.projectx-nav-button')?.click() ?? (location.hash = 'projectx-settings')").catch(() => siteView.loadURL('https://funpay.com/chat/#projectx-settings'));
});

// ---- аккаунты ----
let accountList = [], accountSwitched = false;
async function loadAccounts() {
  const result = await call(api.accounts());
  accountList = result.accounts;
  renderAccounts();
}
function renderAccounts() {
  $('accounts-banner').hidden = !(accountSwitched && status?.running);
  const list = $('account-list');
  if (!accountList.length) { list.replaceChildren(node('p', 'Аккаунтов пока нет. Добавьте golden_key ниже.', 'hint')); return; }
  list.replaceChildren(...accountList.map(account => {
    const card = node('div', null, 'card acc-card' + (account.active ? ' active' : ''));
    const ava = node('div', null, 'acc-ava');
    if (account.avatar && /^data:image\//.test(account.avatar)) { const img = node('img'); img.src = account.avatar; img.alt = ''; ava.append(img); }
    else ava.textContent = (account.username || '?').slice(0, 1).toUpperCase();
    const info = node('div', null, 'acc-info');
    info.append(node('b', account.username), node('span', account.userId ? 'ID ' + account.userId : 'ещё не проверен'));
    card.append(ava, info);
    if (account.active) card.append(node('span', 'активный', 'acc-badge'));
    else {
      const use = node('button', 'Переключиться', 'secondary small'); use.type = 'button';
      use.addEventListener('click', guard(async () => {
        accountList = await call(api.switchAccount(account.id));
        accountSwitched = true; renderAccounts();
        toast(status?.running ? `Выбран ${account.username}. Перезапустите бота.` : `Выбран ${account.username}. Бот запустится на нём.`);
      }));
      const del = node('button', '🗑', 'secondary small'); del.type = 'button'; del.title = 'Убрать из списка';
      del.addEventListener('click', guard(async () => {
        if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Точно?'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = '🗑'; }, 3000); return; }
        accountList = await call(api.removeAccount(account.id)); renderAccounts();
      }));
      card.append(use, del);
    }
    return card;
  }));
}
$('account-form').addEventListener('submit', guard(async event => {
  event.preventDefault();
  const input = $('account-key');
  const key = input.value.trim();
  input.value = '';
  accountList = await call(api.addAccount(key));
  renderAccounts();
  toast('Аккаунт добавлен');
}));
$('accounts-restart').addEventListener('click', () => { accountSwitched = false; restartBot(); });

// ---- /команды (автоответчик бота) ----
let commands = [], commandVars = [], commandsDirty = false, lastText = null, commandsChanged = false;
async function loadCommands() {
  const result = await call(api.commands());
  commands = result.commands; commandVars = result.variables; commandsDirty = false;
  renderCommands();
}
function markCommands() { commandsDirty = true; $('cmd-message').value = 'Есть несохранённые изменения'; }
function renderCommands() {
  $('commands-banner').hidden = !(status?.running && commandsChanged);
  $('cmd-vars').replaceChildren(...commandVars.map(([name, hint]) => {
    const button = node('button', null, 'cmd-var'); button.type = 'button';
    button.append(node('code', name), node('span', hint));
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const area = lastText && document.contains(lastText) ? lastText : $('cmd-list').querySelector('textarea');
      if (!area) return toast('Сначала добавьте команду.');
      area.focus();
      area.setRangeText(name, area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    });
    return button;
  }));
  const list = $('cmd-list');
  if (!commands.length) { list.replaceChildren(node('div', 'Команд пока нет. Нажмите «+ Добавить команду».', 'card cmd-empty hint')); return; }
  list.replaceChildren(...commands.map((item, index) => {
    const card = node('div', null, 'card cmd-card' + (item.enabled ? '' : ' off'));
    const row = node('div', null, 'cmd-row');
    const name = node('input', null, 'cmd-name'); name.value = item.command; name.placeholder = '/команда'; name.setAttribute('aria-label', 'Команда');
    name.addEventListener('input', () => { item.command = name.value; markCommands(); });
    const enabled = node('label'); const on = node('input'); on.type = 'checkbox'; on.checked = item.enabled;
    on.addEventListener('change', () => { item.enabled = on.checked; card.classList.toggle('off', !on.checked); markCommands(); });
    enabled.append(on, document.createTextNode('включена'));
    const tg = node('label'); const tgBox = node('input'); tgBox.type = 'checkbox'; tgBox.checked = item.telegram;
    tg.append(tgBox, document.createTextNode('уведомить в Telegram'));
    const remove = node('button', '🗑', 'secondary cmd-del'); remove.type = 'button'; remove.title = 'Удалить команду';
    remove.addEventListener('click', () => { commands.splice(index, 1); markCommands(); renderCommands(); });
    row.append(name, node('span', '→', 'arrow'), node('span', null, 'grow'), enabled, tg, remove);
    const text = node('textarea'); text.value = item.response; text.placeholder = 'Текст ответа покупателю'; text.setAttribute('aria-label', 'Ответ');
    const fit = area => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 2 + 'px'; };
    text.addEventListener('input', () => { item.response = text.value; fit(text); markCommands(); });
    requestAnimationFrame(() => fit(text));
    text.addEventListener('focus', () => { lastText = text; });
    card.append(row, text);
    const note = node('textarea', null, 'cmd-note'); note.value = item.notification || ''; note.placeholder = 'Текст уведомления в Telegram (необязательно)';
    note.hidden = !item.telegram;
    note.addEventListener('input', () => { item.notification = note.value; markCommands(); });
    note.addEventListener('focus', () => { lastText = note; });
    tgBox.addEventListener('change', () => { item.telegram = tgBox.checked; note.hidden = !tgBox.checked; markCommands(); });
    card.append(note);
    return card;
  }));
}
$('cmd-add').addEventListener('click', () => {
  commands.unshift({ command: '/', response: '', enabled: true, telegram: false, notification: '' });
  markCommands(); renderCommands();
  const first = $('cmd-list').querySelector('.cmd-name'); first?.focus(); first?.setSelectionRange(1, 1);
});
$('cmd-save').addEventListener('click', guard(async () => {
  const result = await call(api.saveCommands(commands));
  commands = result.commands; commandsDirty = false; commandsChanged = true;
  $('cmd-message').value = '';
  renderCommands();
  toast(status?.running ? 'Команды сохранены. Перезапустите бота, чтобы применить.' : 'Команды сохранены');
}));
$('commands-restart').addEventListener('click', () => { commandsChanged = false; restartBot(); });

// ---- перевод сообщений в чате FunPay ----
// Сайт открыт без preload, поэтому лаунчер сам забирает со страницы сообщения без кириллицы,
// переводит их через главный процесс и вставляет перевод под оригиналом.
const TRANSLATE_CSS = `.px-translation { margin-top:4px; padding:4px 8px; border-left:2px solid #b873ff; border-radius:4px; background:rgba(184,115,255,.10); color:inherit; opacity:.92; font-size:.95em; white-space:pre-wrap; }
.px-translation b { font-weight:600; opacity:.65; font-size:.82em; margin-right:6px; text-transform:uppercase; }`;
const COLLECT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('.chat-msg-text:not([data-px-tr])')) {
    const text = (el.innerText || '').trim();
    if (!text || /[а-яё]/i.test(text) || !/\\p{L}{2,}/u.test(text) || text.length > 2000) { el.dataset.pxTr = 'skip'; continue; }
    el.dataset.pxTr = 'wait'; el.dataset.pxId = String(Math.random()).slice(2);
    out.push({ id: el.dataset.pxId, text });
    if (out.length >= 20) break;
  }
  return out;
})()`;
const APPLY = items => `(() => {
  for (const item of ${JSON.stringify(items)}) {
    const el = document.querySelector('.chat-msg-text[data-px-id="' + item.id + '"]');
    if (!el) continue;
    el.dataset.pxTr = item.text ? 'done' : 'skip';
    if (!item.text || el.nextElementSibling?.classList.contains('px-translation')) continue;
    const box = document.createElement('div'); box.className = 'px-translation';
    const tag = document.createElement('b'); tag.textContent = (item.from || '?') + ' → ru';
    box.append(tag, document.createTextNode(item.text));
    el.after(box);
  }
})()`;
let translateBusy = false, translateCss = false;
async function translateTick() {
  if (translateBusy || !siteReady || current !== 'chats' || !prefs?.translate) return;
  translateBusy = true;
  try {
    if (!translateCss) { await siteView.insertCSS(TRANSLATE_CSS); translateCss = true; }
    const found = await siteView.executeJavaScript(COLLECT);
    if (!found?.length) return;
    const results = await call(api.translate(found.map(item => item.text)));
    await siteView.executeJavaScript(APPLY(found.map((item, index) => ({ id: item.id, text: results[index]?.text || '', from: results[index]?.from || '' }))));
  } catch { /* страница перезагружается или нет связи — попробуем в следующий раз */ }
  finally { translateBusy = false; }
}
setInterval(translateTick, 1500);

// ---- обновление лаунчера ----
function showUpdate(version) {
  if (!version) return;
  $('update-text').textContent = `Доступно обновление ${version}` + (status?.running ? '. Бот перезапустится сам' : '');
  $('update-bar').hidden = false;
}
$('update-restart').addEventListener('click', guard(async () => { $('update-restart').disabled = true; $('update-text').textContent = 'Перезапускаю…'; await call(api.restartApp()); }));
$('update-later').addEventListener('click', () => { $('update-bar').hidden = true; });

// ---- навигация и события ----
function go(target) {
  current = target;
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== target;
  for (const button of $('navigation').querySelectorAll('button')) button.setAttribute('aria-current', button.dataset.page === target ? 'page' : 'false');
  $('workspace').scrollTop = 0;
  if (target !== 'settings') { draft = { ...prefs }; theme(prefs); }
  if (target === 'settings') renderControls();
  if (target === 'plugins') guard(loadPlugins)();
  if (target === 'logs') guard(loadLogs)();
  if (target === 'functions') guard(loadFunctions)();
  if (target === 'accounts') guard(loadAccounts)();
  if (target === 'commands' && !commandsDirty) guard(loadCommands)();
  if (target === 'chats') openSite();
}
for (const button of $('navigation').querySelectorAll('button')) button.addEventListener('click', () => { if (state) go(button.dataset.page); });

$('start').addEventListener('click', guard(async () => {
  $('start').disabled = true;
  setConsole(true);
  try { status = await call(api.start()); } finally { renderStatus(); }
}));
$('stop').addEventListener('click', guard(async () => {
  $('stop').disabled = true;
  try {
    if (status.running) status = await call(api.stop());
    else if (status.restartPending) status = await call(api.cancelRestart());
    else status = await call(api.start());
  } finally { renderStatus(); }
}));
$('restart').addEventListener('click', guard(async () => { $('restart').disabled = true; status = await call(api.restart()); renderStatus(); }));
$('show-console').addEventListener('click', () => setConsole(true));
$('hide-console').addEventListener('click', () => setConsole(false));
$('setup').addEventListener('click', guard(async () => { await call(api.setup()); toast('Открыл первую настройку в консоли. Когда закончите, перезапустите лаунчер.'); }));
$('open-bot').addEventListener('click', guard(() => call(api.open('bot'))));
$('pf-refresh').addEventListener('click', () => loadProfile(true));
$('pf-eye').addEventListener('click', guard(async () => {
  const result = await call(api.preferences({ hideBalance: !prefs.hideBalance }));
  prefs = result.prefs; draft.hideBalance = prefs.hideBalance; state.prefs = prefs;
  applyBalance();
  if (state.updateVersion) showUpdate(state.updateVersion);
}));
$('pf-open').addEventListener('click', guard(() => call(api.openUrl(profile.url))));
const restartBot = guard(async () => { status = await call(api.restart()); pluginsChanged = false; renderStatus(); toast('Бот перезапускается'); });
$('functions-restart').addEventListener('click', restartBot);
$('plugins-restart').addEventListener('click', restartBot);
$('open-plugins').addEventListener('click', guard(() => call(api.open('plugins'))));
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', guard(() => call(api.open(button.dataset.open))));
$('plugins-refresh').addEventListener('click', guard(loadPlugins));
$('plugin-search').addEventListener('input', renderPlugins);
$('logs-refresh').addEventListener('click', guard(loadLogs));
$('log-search').addEventListener('input', renderLogs);
$('settings-form').addEventListener('submit', guard(async event => {
  event.preventDefault();
  const result = await call(api.preferences(draft));
  prefs = result.prefs; draft = { ...prefs };
  state.prefs = prefs; state.bot = result.bot; state.python = result.python;
  theme(prefs); renderControls(); renderEnvironment(); renderStatus(); applySiteMute();
  toast('Настройки сохранены');
}));

api.onEvent(event => {
  if (event.type === 'line') addLine(event.line);
  else if (event.type === 'status') {
    const wasRunning = status?.running;
    status = event.status; renderStatus(); applySiteMute();
    if (current === 'plugins') renderPlugins();
    if (wasRunning && !status.running && status.lastExit && !status.lastExit.expected) toast('Бот завершился с ошибкой. Смотрите консоль.', 'error');
  } else if (event.type === 'notify') {
    if (prefs?.sounds && SOUND_KEYS[event.kind]) ProjectXSounds.play(prefs[SOUND_KEYS[event.kind]], prefs.soundVolume);
  } else if (event.type === 'update-ready') {
    showUpdate(event.version);
  } else if (event.type === 'account-switched') {
    profile = null; showProfile(null);
    if (siteReady) siteView.loadURL('https://funpay.com/chat/');
    if (current === 'accounts') renderAccounts();
  } else if (event.type === 'open-site') {
    go('chats');
    if (event.url) { if (siteReady) siteView.loadURL(event.url); else pendingSiteUrl = event.url; }
  } else if (event.type === 'profile') showProfile(event.profile, event.error);
  else if (event.type === 'confirm-exit') {
    const prompt = $('exit-prompt');
    prompt.hidden = false;
    prompt.classList.remove('run'); void prompt.offsetWidth; prompt.classList.add('run');
    prompt.style.setProperty('--exit-time', event.timeout + 'ms');
    clearTimeout(window.exitTimer);
    window.exitTimer = setTimeout(() => { prompt.hidden = true; }, event.timeout);
  }
  else if (event.type === 'error') toast(event.message, 'error');
});

copyWordSetup();
(async () => {
  state = await call(api.state());
  prefs = state.prefs; draft = { ...prefs }; status = state.status;
  theme(prefs);
  for (const line of state.console) addLine(line);
  renderLevels();
  renderEnvironment();
  renderStatus();
  showProfile(state.profile, state.profileError);
  applyBalance();
  await loadPlugins();
})().catch(error => toast(error.message, 'error'));

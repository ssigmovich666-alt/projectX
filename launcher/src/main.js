const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, screen, safeStorage, session: electronSession } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { BotProcess, resolvePython } = require('./bot');
const { inspectBot, listPlugins, togglePlugin, tailLog } = require('./cardinal-data');
const { CATALOG, readMainConfig, readFunctions, setFunction, setValue } = require('./main-cfg');
const { Accounts } = require('./accounts');
let accountsRef = null;
const { FunPaySession, RateLimitError } = require('./funpay');
const fsp = require('node:fs/promises');
const { loadPreferences, savePreferences } = require('./preferences');
const { NotifyDetector } = require('./notify');
const { readCommands, saveCommands } = require('./commands');
const { Translator } = require('./translate');
const { runStartupUpdate } = require('./updater');
const translator = new Translator({ fetch: (...args) => globalThis.fetch(...args) });

const SOUND_TYPES = ['mp3', 'ogg', 'wav', 'm4a', 'webm'];
const icon = path.join(__dirname, '..', 'assets', 'icon.ico');
// Данные лаунчера остаются в прежней папке, чтобы настройки не сбросились после переименования.
app.setPath('userData', path.join(app.getPath('appData'), 'Cardinal Launcher'));
// Лаунчер лежит рядом с ботом: D:\MAIN\FunPayCardinal-main\CardinalLauncher и ...\FunPayCardinal-main
const launcherRoot = app.isPackaged ? path.dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath) : path.join(__dirname, '..');
const defaults = { botDir: [path.join(launcherRoot, 'FunPayCardinal-main'), path.join(launcherRoot, '..', 'FunPayCardinal-main'), path.join(launcherRoot, '..', '..', 'FunPayCardinal-main')]
  .map(dir => path.resolve(dir)).find(dir => fs.existsSync(path.join(dir, 'main.py'))) || path.resolve(launcherRoot, '..', 'FunPayCardinal-main') };
let dataDir, window, tray, prefs, quitting = false;
const bot = new BotProcess();
const consoleLines = [];
let python = null;
let profile = null, profileTimer = null, profileBusy = null, profileDelay = 5000, profileError = null;
let fp = null, fpKey = null;
let lastCloseAttempt = 0;

function emit(event) {
  if (window && !window.isDestroyed()) window.webContents.send('cl:event', event);
}
bot.on('line', line => {
  consoleLines.push(line);
  if (consoleLines.length > 600) consoleLines.splice(0, consoleLines.length - 600);
  emit({ type: 'line', line });
  if (line.stream === 'out') notifier.line(line.text);
});
// Звуки уведомлений: события берутся из вывода бота, звук играет окно лаунчера.
const notifier = new NotifyDetector({ emit: event => notify(event), me: () => profile?.username });
function notify(event) {
  emit({ type: 'notify', ...event });
  if (prefs?.popups && prefs.popupKinds?.[event.kind] !== false) showPopup(event);
}

// ---- Всплывающие уведомления справа снизу (отдельное прозрачное окно поверх всех) ----
let popupWindow = null, popupReady = null;
function popupBounds(height) {
  const area = screen.getPrimaryDisplay().workArea, width = 384;
  height = Math.max(1, Math.min(height, area.height - 20));
  return { width, height, x: area.x + area.width - width - 4, y: area.y + area.height - height - 4 };
}
function ensurePopup() {
  if (popupWindow && !popupWindow.isDestroyed()) return popupReady;
  popupWindow = new BrowserWindow({
    ...popupBounds(1), frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'popup-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  popupWindow.setAlwaysOnTop(true, 'pop-up-menu');
  popupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popupWindow.webContents.on('will-navigate', event => event.preventDefault());
  popupReady = popupWindow.loadFile(path.join(__dirname, 'popup.html'));
  popupWindow.on('closed', () => { popupWindow = null; });
  return popupReady;
}
async function showPopup(event) {
  await ensurePopup();
  popupWindow.webContents.send('popup:theme', { accent: prefs.accent, seconds: prefs.popupSeconds });
  popupWindow.webContents.send('popup:notify', event);
}
ipcMain.on('popup:resize', (event, height) => {
  if (!popupWindow || event.sender !== popupWindow.webContents) return;
  height = Number(height) || 0;
  if (height < 20) { popupWindow.hide(); return; }
  popupWindow.setBounds(popupBounds(height));
  if (!popupWindow.isVisible()) popupWindow.showInactive();
});
ipcMain.on('popup:open', (event, data) => {
  if (!popupWindow || event.sender !== popupWindow.webContents || !window) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
  const chatId = /^\d+$/.test(String(data?.chatId || '')) ? data.chatId : null;
  const order = /^[A-Z0-9]+$/i.test(String(data?.order || '')) ? data.order : null;
  const url = chatId ? `https://funpay.com/chat/?node=${chatId}` : order ? `https://funpay.com/orders/${order}/` : null;
  emit({ type: 'open-site', url });
});
bot.on('status', status => { if (!status.running) notifier.reset(); });
bot.on('status', status => { emit({ type: 'status', status }); updateTray(); });

function register(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents) return { ok: false, error: 'Неизвестное окно.' };
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}

async function detectPython() {
  python = await resolvePython(prefs.python, prefs.botDir);
  return python;
}

async function startBot() {
  if (bot.running) throw new Error('Бот уже запущен.');
  if (!python) await detectPython();
  if (!python) throw new Error('Python не найден. Укажите путь к python.exe в настройках.');
  bot.start({ python: python.command, botDir: prefs.botDir, autorestart: prefs.autorestart });
  return bot.status();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1160, height: 790, minWidth: 880, minHeight: 650,
    title: 'ProjectX', icon, backgroundColor: '#0a0710', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#EADCF7', height: 34 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('minimize', () => { if (prefs.tray) window.hide(); });
  window.on('close', event => {
    if (quitting) return;
    if (prefs.tray) { event.preventDefault(); window.hide(); return; }
    if (!bot.running) return;
    event.preventDefault();
    // Вместо системного окна: первое нажатие — подсказка внутри лаунчера, второе в течение 4 с — выход.
    if (Date.now() - lastCloseAttempt < 4000) { quit(); return; }
    lastCloseAttempt = Date.now();
    emit({ type: 'confirm-exit', timeout: 4000 });
  });
  window.on('closed', () => { if (popupWindow && !popupWindow.isDestroyed()) popupWindow.destroy(); });
  window.loadFile(path.join(__dirname, 'index.html'));
}

// ---- Расширение ProjectX (фоны и темы FunPay) во встроенном сайте ----
// Сначала берём папку расширения рядом с лаунчером (D:\MAIN\FunPayCardinal-main\ProjectX), чтобы правки
// расширения сразу попадали в программу; если её нет — копию, вшитую в exe.
let extensionLoaded = null;
function extensionFolder() {
  const candidates = [path.resolve(launcherRoot, '..', 'ProjectX'), path.resolve(launcherRoot, 'ProjectX'),
    app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', 'extension')];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'manifest.json')));
}
// Команды для подстановки в поле чата (/1 → полный текст) лежат рядом с расширением в commands.json:
// так их видит и встроенный FunPay, и Chrome с этим же расширением. Ключи и пароли сюда не попадают.
async function exportCommands() {
  const folder = extensionFolder();
  if (!folder || (app.isPackaged && folder.startsWith(process.resourcesPath))) return;
  const { commands } = await readCommands(prefs.botDir);
  const list = commands.filter(c => c.enabled).map(c => ({ command: c.command, response: c.response }));
  const target = path.join(folder, 'commands.json');
  await fsp.writeFile(target + '.tmp', JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(target + '.tmp', target);
}
function loadProjectXExtension(fpSession) {
  if (extensionLoaded) return extensionLoaded;
  const folder = extensionFolder();
  const loader = fpSession.extensions || fpSession;
  extensionLoaded = folder
    ? loader.loadExtension(folder, { allowFileAccess: true }).then(ext => ({ name: ext.name, version: ext.version, folder }), error => ({ error: error.message }))
    : Promise.resolve({ error: 'Папка расширения ProjectX не найдена.' });
  return extensionLoaded;
}

// ---- FunPay: одна сессия на golden_key из _main.cfg ----
async function session() {
  const config = await readMainConfig(prefs.botDir);
  const key = config['FunPay.golden_key'];
  if (!fp || key !== fpKey) {
    fp = new FunPaySession({ goldenKey: key, userAgent: config['FunPay.user_agent'], fetch: globalThis.fetch });
    fpKey = key;
  }
  return fp;
}
const profileFile = () => path.join(dataDir, 'profile.json');

// Профиль: после первого входа хранится на диске (без golden_key) и показывается сразу,
// потом обновляется каждые prefs.profileInterval секунд. Страница пользователя (рейтинг, отзывы) — раз в минуту.
// При 429 или ошибке интервал растёт до 2 минут, пока окно скрыто — опрос на паузе.
function pollProfile(force) {
  if (profileBusy) return profileBusy;
  clearTimeout(profileTimer);
  const base = prefs.profileInterval * 1000;
  if (!force && window && (!window.isVisible() || window.isMinimized())) {
    profileTimer = setTimeout(() => pollProfile(false), base);
    return Promise.resolve();
  }
  profileBusy = (async () => {
    try {
      const full = force || !profile?.userLoadedAt || Date.now() - profile.userLoadedAt > 60000;
      profile = await (await session()).profile({ full, previous: profile });
      profileError = null;
      profileDelay = base;
      fsp.writeFile(profileFile(), JSON.stringify(profile)).catch(() => {});
      if (accountsRef && fpKey) accountsRef.update(fpKey, profile).catch(() => {});
    } catch (error) {
      profileError = error.message;
      profileDelay = Math.min(120000, Math.max(error instanceof RateLimitError ? base * 2 : 15000, profileDelay * 2));
    } finally {
      profileBusy = null;
      emit({ type: 'profile', profile, error: profileError, next: profileDelay });
      profileTimer = setTimeout(() => pollProfile(false), profileDelay);
    }
  })();
  return profileBusy;
}

// ---- Обновления из папки src рядом с exe ----
// Новые файлы приходят в CardinalLauncher\src и package.json. Лаунчер раз в 5 с сверяет версию
// и, когда она новее запущенной, предлагает перезапуск (бот после перезапуска поднимается сам).
let updateVersion = null, updateSeen = null;
const versionParts = text => String(text || '0').split('.').map(n => parseInt(n, 10) || 0);
const isNewer = (a, b) => { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
function watchUpdates() {
  if (!app.isPackaged) return;
  const file = path.join(launcherRoot, 'package.json');
  setInterval(async () => {
    try {
      const pkg = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (pkg.name !== 'projectx-funpay' || !fs.existsSync(path.join(launcherRoot, 'src', 'main.js'))) return;
      if (!isNewer(pkg.version, global.projectxVersion || app.getVersion())) return;
      // Версия должна продержаться два опроса подряд, чтобы файлы успели докопироваться.
      if (updateSeen !== pkg.version) { updateSeen = pkg.version; return; }
      if (updateVersion === pkg.version) return;
      updateVersion = pkg.version;
      emit({ type: 'update-ready', version: updateVersion });
    } catch { /* файл в процессе записи */ }
  }, 5000);
}
async function restartApp() {
  const resume = bot.running;
  quitting = true;
  await bot.stop();
  const args = process.argv.slice(1).filter(arg => arg !== '--resume-bot');
  if (resume) args.push('--resume-bot');
  // У portable-сборки перезапускаем исходный exe, а не распакованную временную копию.
  const execPath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.relaunch({ execPath, args: process.env.PORTABLE_EXECUTABLE_FILE ? args.filter(arg => arg === '--resume-bot') : args });
  app.exit(0);
}

async function quit() {
  quitting = true;
  await bot.stop();
  app.quit();
}

function updateTray() {
  if (!prefs?.tray) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    tray = new Tray(icon);
    tray.on('double-click', () => { window.show(); window.focus(); });
  }
  tray.setToolTip(`ProjectX · ${bot.running ? 'бот работает' : 'бот остановлен'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть лаунчер', click: () => { window.show(); window.focus(); } },
    bot.running
      ? { label: 'Остановить бота', click: () => bot.stop() }
      : { label: 'Запустить бота', click: () => startBot().catch(error => emit({ type: 'error', message: error.message })) },
    { type: 'separator' },
    { label: 'Выйти', click: quit }
  ]));
}

// Встроенный FunPay: только funpay.com, без preload и Node, всплывающие окна — в обычный браузер.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    params.partition = 'persist:funpay';
    if (!/^https:\/\/funpay\.com\//.test(params.src || '')) event.preventDefault();
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      // Ссылки FunPay и поддержки FunPay открываем тут же, остальное — в обычном браузере.
      if (/^https:\/\/([a-z0-9-]+\.)?funpay\.com\//.test(url)) contents.loadURL(url);
      else if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!/^https:\/\/([a-z0-9-]+\.)?funpay\.com\//.test(url)) { event.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); }
    });
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    dataDir = app.getPath('userData');
    prefs = await loadPreferences(dataDir, defaults);

    register('cl:state', async () => ({
      prefs, version: global.projectxVersion || app.getVersion(), updateVersion, dataDir, bot: await inspectBot(prefs.botDir),
      status: bot.status(), console: consoleLines, python: python || await detectPython(), profile, profileError
    }));
    register('cl:preferences', async changes => {
      const before = prefs;
      prefs = await savePreferences(dataDir, changes, defaults);
      if (before.python !== prefs.python || before.botDir !== prefs.botDir) await detectPython();
      if (before.profileInterval !== prefs.profileInterval || before.botDir !== prefs.botDir) { profileDelay = prefs.profileInterval * 1000; pollProfile(before.botDir !== prefs.botDir); }
      if (bot.options) bot.options.autorestart = prefs.autorestart;
      updateTray();
      return { prefs, bot: await inspectBot(prefs.botDir), python };
    });
    register('cl:start', startBot);
    register('cl:restart-app', restartApp);
    register('cl:stop', async () => { await bot.stop(); return bot.status(); });
    register('cl:restart', async () => {
      if (!bot.running) return startBot();
      await bot.restart({ python: python.command, botDir: prefs.botDir, autorestart: prefs.autorestart });
      return bot.status();
    });
    register('cl:cancel-restart', () => { bot.cancelRestart(); return bot.status(); });
    // Первая настройка Cardinal интерактивна (input()), поэтому открываем её в обычной консоли Windows.
    register('cl:setup', async () => {
      if (!python) await detectPython();
      if (!python) throw new Error('Python не найден.');
      if (process.platform !== 'win32') throw new Error('Первая настройка запускается в консоли Windows.');
      spawn('cmd.exe', ['/c', 'start', '"ProjectX setup"', 'cmd', '/k', `${python.command} main.py`],
        { cwd: prefs.botDir, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    });
    register('cl:plugins', () => listPlugins(prefs.botDir));
    register('cl:toggle-plugin', (file, enabled) => togglePlugin(prefs.botDir, file, enabled));
    register('cl:functions', async () => ({ catalog: CATALOG, values: await readFunctions(prefs.botDir) }));
    register('cl:set-function', (id, value) => setFunction(prefs.botDir, id, value));
    // ---- Аккаунты ----
    const accounts = new Accounts({
      dataDir,
      crypt: {
        encrypt: key => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('Шифрование Windows недоступно, ключ не сохраню.');
          return safeStorage.encryptString(key).toString('base64');
        },
        decrypt: sealed => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
      },
      readKey: async () => (await readMainConfig(prefs.botDir))['FunPay.golden_key'] || '',
      writeKey: async key => {
        await setValue(prefs.botDir, 'FunPay', 'golden_key', key);
        fp = null; fpKey = null; profile = null; profileError = null;
        await fsp.rm(profileFile(), { force: true });
        // Встроенный сайт: новый ключ и новая сессия.
        const fpSession = electronSession.fromPartition('persist:funpay');
        for (const cookie of await fpSession.cookies.get({ domain: 'funpay.com' })) {
          if (['PHPSESSID', 'golden_key'].includes(cookie.name)) await fpSession.cookies.remove(`https://${cookie.domain.replace(/^\./, '')}${cookie.path}`, cookie.name).catch(() => {});
        }
        await fpSession.cookies.set({ url: 'https://funpay.com', domain: '.funpay.com', path: '/', name: 'golden_key', value: key, secure: true, httpOnly: true, expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 });
        emit({ type: 'account-switched' });
        pollProfile(true);
      },
      identify: async key => {
        const config = await readMainConfig(prefs.botDir).catch(() => ({}));
        const probe = new FunPaySession({ goldenKey: key, userAgent: config['FunPay.user_agent'], fetch: globalThis.fetch });
        const info = await probe.profile({ full: true });
        return { username: info.username, id: info.id, avatar: info.avatar };
      }
    });
    register('cl:accounts', async () => ({ accounts: await accounts.list(), running: bot.running }));
    register('cl:add-account', key => accounts.add(key));
    register('cl:switch-account', id => accounts.switchTo(id));
    register('cl:remove-account', id => accounts.remove(id));
    accountsRef = accounts;
    register('cl:translate', texts => prefs.translate ? translator.many(texts) : []);
    register('cl:commands', () => readCommands(prefs.botDir));
    register('cl:save-commands', async list => { const result = await saveCommands(prefs.botDir, list); await exportCommands().catch(() => {}); return result; });
    exportCommands().catch(() => {});
    register('cl:profile', async force => { if (force) await pollProfile(true); return { profile, error: profileError }; });
    register('cl:chats', async () => (await session()).chats());
    // Встроенный сайт FunPay: отдельный профиль браузера, в который кладём golden_key как cookie.
    // В окно лаунчера ключ не передаётся.
    register('cl:funpay-view', async () => {
      const config = await readMainConfig(prefs.botDir);
      const key = config['FunPay.golden_key'];
      if (!key) throw new Error('В configs/_main.cfg нет golden_key.');
      const fpSession = electronSession.fromPartition('persist:funpay');
      const expirationDate = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      await fpSession.cookies.set({ url: 'https://funpay.com', domain: '.funpay.com', path: '/', name: 'golden_key', value: key, secure: true, httpOnly: true, expirationDate });
      await fpSession.cookies.set({ url: 'https://funpay.com', domain: '.funpay.com', path: '/', name: 'cookie_prefs', value: '1', secure: true, expirationDate });
      if (config['FunPay.user_agent']) fpSession.setUserAgent(config['FunPay.user_agent']);
      await loadProjectXExtension(fpSession);
      return 'https://funpay.com/chat/';
    });

    register('cl:open-url', async url => {
      if (!/^https:\/\/funpay\.com\//.test(url)) throw new Error('Открываю только ссылки funpay.com.');
      await shell.openExternal(url);
    });
    register('cl:logs', () => tailLog(prefs.botDir));
    register('cl:open', async kind => {
      const folders = { bot: '', configs: 'configs', logs: 'logs', plugins: 'plugins', storage: 'storage' };
      if (!Object.hasOwn(folders, kind)) throw new Error('Неизвестная папка.');
      const error = await shell.openPath(path.join(prefs.botDir, folders[kind]));
      if (error) throw new Error(error);
    });
    register('cl:choose-python', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Выберите python.exe', properties: ['openFile'], filters: [{ name: 'Python', extensions: ['exe'] }] });
      return result.canceled ? null : result.filePaths[0];
    });
    // Свой звук: копируем файл в папку лаунчера, чтобы он не пропал, если оригинал удалят.
    register('cl:test-popup', kind => {
      const samples = {
        message: { title: 'buyer_2025', text: 'Здравствуйте! Подскажите, товар ещё в наличии?', chatId: '' },
        order: { title: 'Новый заказ #TEST01', text: 'Brawl Stars, Гемы, 170 гемов, 1 шт.' },
        confirm: { title: 'Заказ подтверждён', text: 'Покупатель buyer_2025 подтвердил успешное выполнение заказа #TEST01.' },
        review: { title: 'Новый отзыв', text: 'Покупатель buyer_2025 написал отзыв к заказу #TEST01.' },
        raise: { title: 'Лоты подняты', text: 'Brawl Stars' },
        delivered: { title: 'Товар выдан', text: 'Заказ #TEST01' },
        error: { title: 'Не удалось выдать товар', text: 'Заказ #TEST01' }
      };
      if (!samples[kind]) throw new Error('Неизвестное уведомление.');
      showPopup({ kind, ...samples[kind] });
    });
    register('cl:choose-sound', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Выберите звук уведомления', properties: ['openFile'], filters: [{ name: 'Звук', extensions: SOUND_TYPES }] });
      if (result.canceled) return null;
      const source = result.filePaths[0];
      const ext = path.extname(source).slice(1).toLowerCase();
      if (!SOUND_TYPES.includes(ext)) throw new Error('Поддерживаются mp3, ogg, wav, m4a и webm.');
      if ((await fsp.stat(source)).size > 3 * 1048576) throw new Error('Файл больше 3 МБ. Нужен короткий звук.');
      const folder = path.join(dataDir, 'sounds');
      await fsp.mkdir(folder, { recursive: true });
      for (const old of await fsp.readdir(folder)) if (old.startsWith('custom.')) await fsp.rm(path.join(folder, old), { force: true });
      await fsp.copyFile(source, path.join(folder, 'custom.' + ext));
      prefs = await savePreferences(dataDir, { soundCustomName: path.basename(source) }, defaults);
      return { name: prefs.soundCustomName, prefs };
    });
    register('cl:custom-sound', async () => {
      const folder = path.join(dataDir, 'sounds');
      const file = (await fsp.readdir(folder).catch(() => [])).find(name => name.startsWith('custom.'));
      if (!file) return null;
      const ext = path.extname(file).slice(1);
      const mime = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm' }[ext];
      return `data:${mime};base64,` + (await fsp.readFile(path.join(folder, file))).toString('base64');
    });
    register('cl:choose-bot-dir', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Папка бота (где main.py)', properties: ['openDirectory'], defaultPath: prefs.botDir });
      return result.canceled ? null : result.filePaths[0];
    });

    try { profile = JSON.parse(await fsp.readFile(profileFile(), 'utf8')); } catch { profile = null; }
    createWindow();
    updateTray();
    window.on('show', () => pollProfile(false));
    window.on('restore', () => pollProfile(false));
    pollProfile(false);
    if (prefs.autostart || process.argv.includes('--resume-bot')) startBot().catch(error => emit({ type: 'error', message: error.message }));
    watchUpdates();
    // Фоновая проверка обновлений на GitHub (только у собранного exe). Не блокирует запуск.
    if (app.isPackaged) {
      const updateLog = text => {
        const line = { stream: 'out', text: '[ProjectX] ' + text };
        consoleLines.push(line);
        if (consoleLines.length > 600) consoleLines.splice(0, consoleLines.length - 600);
        emit({ type: 'line', line });
      };
      runStartupUpdate({ appRoot: launcherRoot, botDir: prefs.botDir, currentVersion: global.projectxVersion || app.getVersion(), log: updateLog })
        .then(() => detectPython().catch(() => {}))
        .catch(() => {});
    }
  });
  app.on('before-quit', () => { quitting = true; bot.stop(); });
  app.on('window-all-closed', () => app.quit());
}

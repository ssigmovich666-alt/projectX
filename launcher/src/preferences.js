const fs = require('node:fs/promises');
const path = require('node:path');

const number = (value, fallback, min, max) =>
  Number.isFinite(Number(value)) && value !== '' && value != null
    ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;

// Названия звуков — из src/sounds.js; 'off' = без звука, 'custom' = свой файл.
const SOUNDS = ['off', 'drop', 'bubble', 'chime', 'glass', 'marimba', 'harp', 'kalimba', 'pad', 'breeze', 'tap', 'custom'];
const sound = (value, fallback) => SOUNDS.includes(value) ? value : fallback;
const POPUP_KINDS = ['message', 'order', 'confirm', 'review', 'raise', 'delivered', 'error'];
const THEMES = { terminal: '#39FF6A', violet: '#B873FF', graphite: '#CFD1DD', midnight: '#86BAFF' };

function preferences(value = {}, defaults = {}) {
  // Схема 2: фиолетовая тема по умолчанию (зелёная резала глаза).
  if (value.schema !== 2) { value = { ...value, theme: 'violet', accent: THEMES.violet, schema: 2 }; }
  const theme = Object.hasOwn(THEMES, value.theme) ? value.theme : 'violet';
  return {
    schema: 2,
    botDir: typeof value.botDir === 'string' && value.botDir.trim() ? value.botDir.trim() : (defaults.botDir || ''),
    python: typeof value.python === 'string' ? value.python.trim().slice(0, 1024) : '',
    autostart: value.autostart === true,
    autorestart: value.autorestart !== false,
    tray: value.tray === true,
    theme,
    accent: typeof value.accent === 'string' && /^#[0-9a-f]{6}$/i.test(value.accent) ? value.accent.toUpperCase() : THEMES[theme],
    background: value.background === 'plain' ? 'plain' : 'scan',
    scale: number(value.scale, 100, 80, 125),
    opacity: number(value.opacity, 74, 0, 100),
    glow: value.glow !== false,
    animations: value.animations !== false,
    intensity: number(value.intensity, 45, 0, 100),
    profileInterval: number(value.profileInterval, 5, 5, 300),
    sounds: value.sounds !== false,
    soundVolume: number(value.soundVolume, 50, 0, 150),
    soundMessage: sound(value.soundMessage, 'drop'),
    soundOrder: sound(value.soundOrder, 'chime'),
    soundConfirm: sound(value.soundConfirm, 'harp'),
    soundReview: sound(value.soundReview, 'glass'),
    soundRaise: sound(value.soundRaise, 'tap'),
    soundDelivered: sound(value.soundDelivered, 'off'),
    soundError: sound(value.soundError, 'off'),
    popups: value.popups !== false,
    popupSeconds: number(value.popupSeconds, 10, 3, 60),
    popupKinds: Object.fromEntries(POPUP_KINDS.map(kind => [kind, value.popupKinds?.[kind] !== false])),
    hideBalance: value.hideBalance === true,
    translate: value.translate !== false,
    muteSite: value.muteSite !== false,
    soundCustomName: typeof value.soundCustomName === 'string' ? value.soundCustomName.slice(0, 200) : ''
  };
}

const file = dataDir => path.join(dataDir, 'preferences.json');
async function loadPreferences(dataDir, defaults) {
  try { return preferences(JSON.parse(await fs.readFile(file(dataDir), 'utf8')) ?? {}, defaults); }
  catch { return preferences({}, defaults); }
}
async function savePreferences(dataDir, changes, defaults) {
  const value = preferences({ ...await loadPreferences(dataDir, defaults), ...changes }, defaults);
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = file(dataDir) + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file(dataDir));
  return value;
}

module.exports = { preferences, loadPreferences, savePreferences, THEMES, SOUNDS, POPUP_KINDS };

// Чтение и правка configs/_main.cfg без Python. Формат — configparser с разделителем ":".
// Наружу (в окно) отдаются только ключи из каталога функций: golden_key, token и secretKeyHash туда не попадают.
const fs = require('node:fs/promises');
const path = require('node:path');

const b = (section, key, name) => ({ section, key, name, type: 'toggle' });
const text = (section, key, name) => ({ section, key, name, type: 'text' });
const num = (section, key, name, min, max, suffix = '') => ({ section, key, name, type: 'number', min, max, suffix });

// Каталог повторяет меню Telegram-бота Cardinal. toggle — главный переключатель модуля, settings — раскрываются по ПКМ.
const CATALOG = [
  { category: 'Глобальные переключатели', modules: [
    { id: 'autoRaise', name: 'Автоподнятие', hint: 'Поднимает лоты, как только FunPay разрешает.', toggle: b('FunPay', 'autoRaise') },
    { id: 'autoResponse', name: 'Автоответчик', hint: 'Отвечает на команды из auto_response.cfg.', toggle: b('FunPay', 'autoResponse') },
    { id: 'autoDelivery', name: 'Авто-выдача', hint: 'Выдаёт товар из файлов после оплаты.', toggle: b('FunPay', 'autoDelivery'),
      settings: [b('FunPay', 'multiDelivery', 'Мульти-выдача')] },
    { id: 'autoRestore', name: 'Восстановление лотов', hint: 'Включает лоты обратно после продажи.', toggle: b('FunPay', 'autoRestore') },
    { id: 'autoDisable', name: 'Деактивация лотов', hint: 'Выключает лот, когда товар закончился.', toggle: b('FunPay', 'autoDisable') },
    { id: 'oldMsgGetMode', name: 'Старый режим сообщений', hint: 'Получение сообщений старым способом.', toggle: b('FunPay', 'oldMsgGetMode') },
    { id: 'keepSentMessagesUnread', name: 'Не читать при отправке', hint: 'Оставлять чат непрочитанным после ответа бота.', toggle: b('FunPay', 'keepSentMessagesUnread') }
  ] },
  { category: 'Сообщения покупателям', modules: [
    { id: 'greetings', name: 'Приветствие', hint: 'Пишет первым новому покупателю.', toggle: b('Greetings', 'sendGreetings'),
      settings: [text('Greetings', 'greetingsText', 'Текст приветствия'), b('Greetings', 'ignoreSystemMessages', 'Игнорировать системные сообщения'),
        b('Greetings', 'onlyNewChats', 'Только в новых диалогах'), num('Greetings', 'greetingsCooldown', 'Кулдаун', 0, 365, 'дн.')] },
    { id: 'orderConfirm', name: 'Ответ на подтверждение', hint: 'Сообщение после подтверждения заказа.', toggle: b('OrderConfirm', 'sendReply'),
      settings: [text('OrderConfirm', 'replyText', 'Текст сообщения'), b('OrderConfirm', 'watermark', 'Вотермарка сообщений')] },
    ...[1, 2, 3, 4, 5].map(star => ({ id: `star${star}`, name: `Ответ на отзыв ${'★'.repeat(star)}`, hint: `Ответ на отзыв с ${star} зв.`,
      toggle: b('ReviewReply', `star${star}Reply`), settings: [text('ReviewReply', `star${star}ReplyText`, 'Текст ответа')] }))
  ] },
  { category: 'Уведомления в Telegram', modules: [
    { id: 'telegram', name: 'Telegram-бот', hint: 'Панель управления и уведомления в Telegram.', toggle: b('Telegram', 'enabled'),
      settings: [b('Telegram', 'blockLogin', 'Запретить вход новым пользователям')] },
    { id: 'msgView', name: 'Вид уведомлений о сообщениях', hint: 'Что показывать в уведомлении о новом сообщении.',
      settings: [b('NewMessageView', 'includeMyMessages', 'Отображать мои сообщения'), b('NewMessageView', 'includeFPMessages', 'Отображать сообщения FunPay'),
        b('NewMessageView', 'includeBotMessages', 'Отображать сообщения бота'), b('NewMessageView', 'notifyOnlyMyMessages', 'Увед., если сообщения только от меня'),
        b('NewMessageView', 'notifyOnlyFPMessages', 'Увед., если сообщения только от FP'), b('NewMessageView', 'notifyOnlyBotMessages', 'Увед., если сообщения только от бота'),
        b('NewMessageView', 'showImageName', 'Отображать названия изображений')] }
  ] },
  { category: 'Чёрный список', modules: [
    { id: 'blockDelivery', name: 'Не выдавать товар', hint: 'Пользователям из чёрного списка.', toggle: b('BlockList', 'blockDelivery') },
    { id: 'blockResponse', name: 'Не отвечать на команды', hint: 'Пользователям из чёрного списка.', toggle: b('BlockList', 'blockResponse') },
    { id: 'blockNewMsg', name: 'Не увед. о сообщениях', hint: 'От пользователей из чёрного списка.', toggle: b('BlockList', 'blockNewMessageNotification') },
    { id: 'blockNewOrder', name: 'Не увед. о заказах', hint: 'От пользователей из чёрного списка.', toggle: b('BlockList', 'blockNewOrderNotification') },
    { id: 'blockCommand', name: 'Не увед. о командах', hint: 'От пользователей из чёрного списка.', toggle: b('BlockList', 'blockCommandNotification') }
  ] },
  { category: 'Прочее', modules: [
    { id: 'other', name: 'Запросы и вотермарка', hint: 'Задержка между запросами к FunPay и подпись сообщений бота.',
      settings: [num('Other', 'requestsDelay', 'Задержка запросов', 1, 100, 'с'), text('Other', 'watermark', 'Вотермарка')] }
  ] }
];

const FIELDS = new Map();
for (const { modules } of CATALOG) for (const module of modules) {
  for (const item of [module.toggle, ...(module.settings || [])].filter(Boolean)) FIELDS.set(`${item.section}.${item.key}`, item);
}

function parse(source) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) { section = header[1]; entries.push({ type: 'section', section, line: i }); continue; }
    if (!section || /^\s/.test(line) || !line.trim() || /^[#;]/.test(line)) continue;
    const cut = line.indexOf(':');
    if (cut < 0) continue;
    let end = i;
    const parts = [line.slice(cut + 1).trim()];
    while (end + 1 < lines.length && /^\s+\S?/.test(lines[end + 1]) && lines[end + 1] !== '' && !/^\[/.test(lines[end + 1])) {
      end++; parts.push(lines[end].replace(/^\s/, ''));
    }
    entries.push({ type: 'key', section, key: line.slice(0, cut).trim(), value: parts.join('\n').replace(/\n+$/, ''), start: i, end });
  }
  return { lines, entries };
}

const file = botDir => path.join(botDir, 'configs', '_main.cfg');

async function readMainConfig(botDir) {
  const { entries } = parse(await fs.readFile(file(botDir), 'utf8'));
  const all = {};
  for (const entry of entries) if (entry.type === 'key') all[`${entry.section}.${entry.key}`] = entry.value;
  return all;
}

// Значения только для каталога функций.
async function readFunctions(botDir) {
  const all = await readMainConfig(botDir);
  const values = {};
  for (const id of FIELDS.keys()) values[id] = all[id] ?? '';
  return values;
}

function validate(item, value) {
  if (item.type === 'toggle') return value === true || value === '1' ? '1' : '0';
  if (item.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number) || number < item.min || number > item.max) throw new Error(`${item.name}: число от ${item.min} до ${item.max}.`);
    return item.key === 'requestsDelay' ? String(Math.round(number)) : String(number);
  }
  const textValue = String(value ?? '').replace(/\r/g, '');
  if (item.key === 'greetingsText' && !textValue.trim()) throw new Error('Текст приветствия не может быть пустым.');
  return textValue;
}

let backedUp = new Set();
async function backup(botDir) {
  if (backedUp.has(botDir)) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  await fs.copyFile(file(botDir), path.join(botDir, 'configs', `_main-before-launcher-${stamp}.cfg.bak`));
  backedUp.add(botDir);
}

async function setFunction(botDir, id, rawValue) {
  const item = FIELDS.get(id);
  if (!item) throw new Error('Неизвестная настройка.');
  await setValue(botDir, item.section, item.key, validate(item, rawValue));
  return readFunctions(botDir);
}

// Меняет одно значение в _main.cfg, не трогая остальное (комментарии, порядок, переносы строк).
async function setValue(botDir, section, key, value, { createSection = false } = {}) {
  const item = { section, key };
  const source = await fs.readFile(file(botDir), 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const { lines, entries } = parse(source);
  // configparser пишет многострочные значения с табуляцией в начале строк продолжения.
  const rendered = `${item.key} : ${value.split('\n').join('\n\t')}`.split('\n');
  const entry = entries.find(e => e.type === 'key' && e.section === item.section && e.key === item.key);
  if (entry) lines.splice(entry.start, entry.end - entry.start + 1, ...rendered);
  else {
    const header = entries.find(e => e.type === 'section' && e.section === item.section);
    if (!header && createSection) {
      while (lines.at(-1) === '') lines.pop();
      lines.push('', `[${section}]`, ...rendered, '');
    } else {
      if (!header) throw new Error(`В _main.cfg нет секции [${item.section}].`);
      const last = entries.filter(e => e.type === 'key' && e.section === item.section).pop();
      lines.splice((last ? last.end : header.line) + 1, 0, ...rendered);
    }
  }
  await backup(botDir);
  const temporary = file(botDir) + '.launcher.tmp';
  await fs.writeFile(temporary, lines.join(eol), 'utf8');
  await fs.rename(temporary, file(botDir));
}

module.exports = { CATALOG, readMainConfig, readFunctions, setFunction, setValue, parse, _resetBackup: () => { backedUp = new Set(); } };

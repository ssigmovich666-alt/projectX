const test = require('node:test');
const assert = require('node:assert');
const { NotifyDetector } = require('../src/notify');
const { preferences } = require('../src/preferences');

const T = '[21-11-2026 16:40:01]> I: ';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function detector() {
  const events = [];
  return { events, d: new NotifyDetector({ emit: e => events.push(e), me: () => 'AlexShop', delay: 40 }) };
}

test('сообщение покупателя: одно уведомление на пачку, с текстом', async () => {
  const { events, d } = detector();
  d.line(T + 'Новое сообщение в переписке с пользователем buyer1 (CID: 123):');
  d.line(T + '└───> buyer1: привет');
  d.line(T + 'Новое сообщение в переписке с пользователем buyer1 (CID: 123):');
  d.line(T + '└───> buyer1: ещё');
  await wait(80);
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual([events[0].kind, events[0].title, events[0].text, events[0].chatId, events[0].count], ['message', 'buyer1', 'ещё', '123', 2]);
});

test('разные чаты дают разные уведомления', async () => {
  const { events, d } = detector();
  d.line(T + 'Новое сообщение в переписке с пользователем a (CID: 1):');
  d.line(T + '└───> a: 1');
  d.line(T + 'Новое сообщение в переписке с пользователем b (CID: 2):');
  d.line(T + '└───> b: 2');
  await wait(80);
  assert.deepStrictEqual(events.map(e => e.title), ['a', 'b']);
});

test('свои сообщения и ответы бота без уведомления', async () => {
  const { events, d } = detector();
  d.line(T + 'Новое сообщение в переписке с пользователем buyer1 (CID: 1):');
  d.line(T + '└───> AlexShop: спасибо за покупку');
  await wait(80);
  assert.deepStrictEqual(events, []);
});

test('заказ с названием лота, подтверждение, отзыв, поднятие, выдача', async () => {
  const { events, d } = detector();
  d.line(T + 'Новое сообщение в переписке с пользователем buyer2 (CID: 2):');
  d.line(T + '└───> FunPay: Покупатель buyer2 оплатил заказ #ABC123. Brawl Stars, Гемы, 170 гемов. buyer2, не забудьте потом нажать кнопку «Подтвердить выполнение заказа».');
  d.line(T + 'Новый заказ! ID: #ABC123');
  await wait(60);
  d.line(T + 'Товар для заказа ABC123 выдан.');
  d.line(T + 'Новое сообщение в переписке с пользователем buyer2 (CID: 2):');
  d.line(T + '└───> FunPay: Покупатель buyer2 подтвердил успешное выполнение заказа #ABC123.');
  d.line(T + 'Новое сообщение в переписке с пользователем buyer2 (CID: 2):');
  d.line(T + '└───> FunPay: Покупатель buyer2 написал отзыв к заказу #ABC123.');
  d.line(T + 'Все лоты категории "Brawl Stars" подняты!');
  await wait(80);
  assert.deepStrictEqual(events.map(e => e.kind), ['order', 'delivered', 'confirm', 'review', 'raise']);
  assert.match(events[0].text, /170 гемов/);
  assert.strictEqual(events[0].chatId, '2');
  assert.strictEqual(events[4].text, 'Brawl Stars');
});

test('настройки звуков по умолчанию', () => {
  const p = preferences({ schema: 2 });
  assert.strictEqual(p.sounds, true);
  assert.strictEqual(p.soundMessage, 'drop');
  assert.strictEqual(p.popups, true);
  assert.strictEqual(p.popupSeconds, 10);
  assert.strictEqual(preferences({ schema: 2, soundOrder: 'siren' }).soundOrder, 'chime');
});

test('команды: запись и чтение в формате бота', () => {
  const { parse, serialize, validate } = require('../src/commands');
  const list = validate([
    { command: '/1', response: 'Здравствуйте, напишите отзыв\nОбъясняю: заказов много\n\nСпасибо, $username!' },
    { command: 'Привет | hi', response: 'Привет!', enabled: false, telegram: true, notification: '$username написал привет' }
  ]);
  const text = serialize(list);
  assert.match(text, /^\[\/1\]\nresponse: Здравствуйте, напишите отзыв\n\tОбъясняю: заказов много\n\t\n\tСпасибо, \$username!\nenabled: 1/);
  assert.match(text, /\[привет\|hi\]/);
  const back = parse(text);
  assert.strictEqual(back[0].response, list[0].response);
  assert.deepStrictEqual([back[1].command, back[1].enabled, back[1].telegram, back[1].notification], ['привет|hi', false, true, '$username написал привет']);
  assert.throws(() => validate([{ command: '/1', response: 'a' }, { command: 'x|/1', response: 'b' }]), /дважды/);
});

test('аккаунты: ключ хранится зашифрованным и не попадает в список', async () => {
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  const { Accounts } = require('../src/accounts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  let config = 'a'.repeat(32);
  const accounts = new Accounts({
    dataDir: dir,
    crypt: { encrypt: k => Buffer.from(k).toString('base64').split('').reverse().join(''), decrypt: s => Buffer.from(s.split('').reverse().join(''), 'base64').toString() },
    readKey: async () => config, writeKey: async k => { config = k; },
    identify: async k => ({ username: k.startsWith('a') ? 'First' : 'Second', id: k.startsWith('a') ? 1 : 2 })
  });
  let list = await accounts.list();
  assert.deepStrictEqual(list.map(a => [a.username, a.active]), [['First', true]]);
  await assert.rejects(accounts.add('short'), /32 символа/);
  list = await accounts.add('b'.repeat(32));
  assert.strictEqual(list.length, 2);
  assert.ok(!JSON.stringify(list).includes('b'.repeat(32)));
  assert.ok(!fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8').includes('b'.repeat(32)));
  await assert.rejects(accounts.add('b'.repeat(32)), /уже добавлен/);
  list = await accounts.switchTo(list[1].id);
  assert.strictEqual(config, 'b'.repeat(32));
  assert.deepStrictEqual(list.map(a => a.active), [false, true]);
  await assert.rejects(accounts.remove(list[1].id), /Нельзя удалить/);
  list = await accounts.remove(list[0].id);
  assert.deepStrictEqual(list.map(a => a.username), ['Second']);
});

test('перевод: только некириллические сообщения, с кэшем', async () => {
  const { Translator, needsTranslation } = require('../src/translate');
  assert.strictEqual(needsTranslation('Привет'), false);
  assert.strictEqual(needsTranslation('hello, is it available?'), true);
  assert.strictEqual(needsTranslation('123 !!'), false);
  let calls = 0;
  const t = new Translator({ fetch: async url => { calls++; assert.match(url, /tl=ru/); return { ok: true, status: 200, json: async () => [[['Привет, ', 'hello, '], ['это есть?', 'is it available?']], null, 'en'] }; } });
  const [a, b, c] = await t.many(['hello, is it available?', 'Привет', 'hello, is it available?']);
  assert.deepStrictEqual(a, { text: 'Привет, это есть?', from: 'en' });
  assert.strictEqual(b, null);
  assert.deepStrictEqual(c, a);
  assert.strictEqual(calls, 1);
});

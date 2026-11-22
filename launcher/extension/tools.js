'use strict';
// ProjectX: инструменты продавца для FunPay.
// Цена для покупателя, кнопки лотов (деактивировать/активировать, дублировать, удалить),
// жёлтое свечение неактивных лотов, закрепление категорий, последние покупки сверху,
// копирование слова двойным кликом. Запросы идут к самому funpay.com с вашими cookie.
(() => {
  if (window.__projectxTools) return;
  window.__projectxTools = true;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const appData = () => { try { return JSON.parse(document.body?.dataset.appData || '{}'); } catch { return {}; } };
  const myId = () => String(appData().userId || '');
  const csrf = () => appData()['csrf-token'] || $('input[name="csrf_token"]')?.value || '';

  // ---------- сообщения ----------
  let toastBox;
  function toast(text, kind = '') {
    if (!toastBox) { toastBox = el('div', 'px-toasts'); document.body.append(toastBox); }
    const item = el('div', 'px-toast ' + kind, text);
    toastBox.append(item);
    setTimeout(() => { item.classList.add('px-out'); setTimeout(() => item.remove(), 400); }, 3500);
  }
  function confirmBox(title, text, okText, danger) {
    return new Promise(resolve => {
      const shade = el('div', 'px-modal-shade');
      const box = el('div', 'px-modal');
      const buttons = el('div', 'px-modal-buttons');
      const cancel = el('button', 'px-btn', 'Отмена');
      const ok = el('button', 'px-btn ' + (danger ? 'px-danger' : 'px-primary'), okText);
      buttons.append(cancel, ok);
      box.append(el('b', '', title), el('p', '', text), buttons);
      shade.append(box); document.body.append(shade);
      const close = value => { shade.remove(); resolve(value); };
      cancel.onclick = () => close(false); ok.onclick = () => close(true);
      shade.onclick = event => { if (event.target === shade) close(false); };
      ok.focus();
    });
  }

  // ---------- запросы к FunPay ----------
  async function post(url, data) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) if (value !== undefined && value !== null) body.append(key, value);
    const response = await fetch(new URL(url, 'https://funpay.com').href, { method: 'POST', credentials: 'include', body,
      headers: { 'accept': '*/*', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' } });
    if (!response.ok) throw new Error('FunPay ответил ' + response.status);
    const json = await response.json().catch(() => ({}));
    if (json.error) throw new Error(typeof json.error === 'string' ? json.error : 'FunPay вернул ошибку');
    if (json.errors && Object.keys(json.errors).length) throw new Error(Object.values(json.errors).flat().join(', '));
    return json;
  }

  // Поля формы редактирования лота — так же, как их собирает FunPayAPI в боте.
  async function offerFields(offerId) {
    const response = await fetch('https://funpay.com/lots/offerEdit?offer=' + encodeURIComponent(offerId), { credentials: 'include' });
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const form = $('form.form-offer-editor', page);
    if (!form) throw new Error($('p.lead', page)?.textContent?.trim() || 'Не удалось открыть лот');
    const fields = {};
    for (const input of $$('input[name]', form)) {
      if (input.type === 'checkbox') { if (input.hasAttribute('checked')) fields[input.name] = 'on'; continue; }
      if (input.type === 'radio') { if (input.hasAttribute('checked')) fields[input.name] = input.getAttribute('value') || ''; continue; }
      if (input.type === 'file' || input.name === 'query') continue;
      fields[input.name] = input.getAttribute('value') || '';
    }
    for (const area of $$('textarea[name]', form)) fields[area.name] = area.textContent || '';
    for (const select of $$('select[name]', form)) {
      if (select.closest('.form-group')?.classList.contains('hidden')) continue;
      const option = $('option[selected]', select) || $('option', select);
      if (option) fields[select.name] = option.getAttribute('value') || '';
    }
    return fields;
  }
  const saveOffer = fields => post('/lots/offerSave', fields);

  // ---------- п.2: цена для покупателя ----------
  // Комиссия у каждой категории своя, поэтому считаем всегда по текущей категории лота:
  // калькулятор FunPay (/lots/calc с node этой страницы), а итог сверяем с таблицей «Цена для покупателей».
  const SPACES = /[\s   ]/g;
  function parseMoney(text) { const m = String(text).replace(SPACES, '').replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; }
  const unitOf = text => { const clean = String(text).replace(SPACES, ''); const m = clean.match(/[^\d.,-]+$/); return m ? m[0] : ''; };
  const methodKey = (name, unit) => String(name).trim().toLowerCase() + '|' + String(unit).replace(SPACES, '');
  const round2 = value => Math.round(value * 100) / 100;
  async function calc(nodeId, price) {
    const json = await post('/lots/calc', { nodeId, price });
    return (json.methods || []).map(m => ({ key: methodKey(m.name, m.unit), name: String(m.name || '').trim(), price: parseMoney(m.price) }));
  }
  function tableMethods(form) {
    return $$('table.table-buyers-prices tr', form).map(tr => {
      const name = ($('th', tr)?.textContent || '').trim(), cell = ($('td', tr)?.textContent || '').trim();
      return { key: methodKey(name, unitOf(cell)), name, unit: unitOf(cell), price: parseMoney(cell) };
    }).filter(m => m.name);
  }
  function setupBuyerPrice() {
    const form = $('form.form-offer-editor');
    const priceInput = form && $('input[name="price"]', form);
    const nodeId = form && ($('input[name="node_id"]', form)?.value || new URLSearchParams(location.search).get('node'));
    if (!priceInput || !nodeId || form.dataset.pxBuyer) return;
    form.dataset.pxBuyer = '1';
    const group = priceInput.closest('.form-group') || priceInput.parentElement;
    const box = el('div', 'form-group px-buyer');
    box.append(el('label', 'control-label', 'Цена для покупателя'));
    const row = el('div', 'px-buyer-row');
    const input = el('input', 'form-control'); input.type = 'text'; input.inputMode = 'decimal'; input.placeholder = '';
    const method = el('select', 'form-control');
    const note = el('div', 'help-block px-buyer-note', 'Впишите, сколько должен заплатить покупатель, и цена лота подберётся сама по комиссии этой категории.');
    row.append(input, method); box.append(row, note);
    group.after(box);

    const fillMethods = () => {
      const list = tableMethods(form);
      if (!list.length) return;
      // По умолчанию считаем для оплаты по СБП; другой способ можно выбрать в списке, он запомнится.
      const sbp = list.find(m => /сбп|sbp/i.test(m.name) && /₽|руб/i.test(m.unit)) || list.find(m => /сбп|sbp/i.test(m.name));
      const keep = method.value || localStorage.getItem('projectx-buyer-method-v2') || sbp?.key;
      const same = [...method.options].map(o => o.value).join() === list.map(m => m.key).join();
      if (!same) method.replaceChildren(...list.map(m => new Option(`${m.name} (${m.unit})`, m.key)));
      method.value = list.some(m => m.key === keep) ? keep : (sbp || list[0]).key;
    };
    fillMethods();
    new MutationObserver(fillMethods).observe(form, { childList: true, subtree: true });
    method.addEventListener('change', () => { localStorage.setItem('projectx-buyer-method-v2', method.value); run(); });

    // Ставим цену и даём самому FunPay пересчитать таблицу.
    const applyPrice = price => {
      priceInput.value = String(price);
      priceInput.dispatchEvent(new Event('input', { bubbles: true }));
      priceInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      priceInput.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const tableValue = key => tableMethods(form).find(m => m.key === key)?.price;
    const waitTable = async (key, before) => {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 150));
        const now = tableValue(key);
        if (now !== before && Number.isFinite(now)) return now;
      }
      return tableValue(key);
    };

    let timer = null, job = 0;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 600); });
    async function run() {
      const target = parseMoney(input.value), key = method.value, my = ++job;
      if (!(target > 0)) { note.textContent = 'Впишите, сколько должен заплатить покупатель.'; return; }
      if (!key) { note.textContent = 'FunPay ещё не показал способы оплаты. Впишите любую цену лота и попробуйте снова.'; return; }
      note.textContent = 'Считаю по комиссии этой категории…';
      try {
        let price, got, rate;
        try {
          // Калькулятор FunPay для этой категории. Способ оплаты ищем по названию и валюте, а не по номеру строки.
          const at = async p => (await calc(nodeId, p)).find(m => m.key === key)?.price;
          const base = 1000, atBase = await at(base);
          if (!(atBase > 0)) throw new Error('нет способа оплаты');
          rate = atBase / base;
          price = round2(target / rate); got = await at(price);
          for (let step = 0; step < 6 && my === job && Math.abs(got - target) > 0.004; step++) {
            price = Math.max(0.01, round2(price + (target - got) / rate)); got = await at(price);
          }
          while (got > target + 0.004 && price > 0.01 && my === job) { price = round2(price - 0.01); got = await at(price); }
        } catch {
          // Калькулятор недоступен: берём комиссию из таблицы на этой странице.
          const cur = parseMoney(priceInput.value) || 100;
          const shown = tableValue(key);
          rate = shown > 0 && cur > 0 ? shown / cur : 1.3;
          price = round2(target / rate);
        }
        if (my !== job) return;
        // Финальная сверка с таблицей самого FunPay: уточняем по тому, как таблица реально меняется.
        let last = null, applied = null;
        for (let step = 0; step < 7 && my === job; step++) {
          const before = tableValue(key);
          applyPrice(price); applied = price;
          const shown = await waitTable(key, before);
          if (!Number.isFinite(shown)) break;
          got = shown;
          if (Math.abs(shown - target) <= 0.004) break;
          let slope = rate || shown / price;
          if (last && last.price !== price && last.shown !== shown) slope = (shown - last.shown) / (price - last.price);
          if (!(slope > 0)) slope = shown / price;
          last = { price, shown };
          let next = Math.max(0.01, round2(price + (target - shown) / slope));
          if (next === price) next = round2(price + (shown > target ? -0.01 : 0.01));
          if (shown > target && step >= 5) next = round2(price - 0.01);
          price = next;
        }
        if (Number.isFinite(got) && got > target + 0.004 && my === job) { applied = round2(applied - 0.01); const before = tableValue(key); applyPrice(applied); got = await waitTable(key, before); }
        if (applied != null) price = applied;
        if (my !== job) return;
        const fee = rate ? Math.round((rate - 1) * 1000) / 10 : null;
        note.textContent = `Цена лота ${price} → покупатель платит ${Number.isFinite(got) ? got : '?'}` +
          (fee != null ? ` (комиссия этой категории для выбранного способа ≈ ${fee}%)` : '') + '. Не забудьте нажать «Сохранить».';
      } catch (error) { if (my === job) note.textContent = 'Не получилось посчитать: ' + error.message; }
    }
  }

  // ---------- п.9, п.10: кнопки лотов и свечение неактивных ----------
  const offerIdOf = item => item.dataset.offer || (item.getAttribute('href') || '').match(/[?&]id=(\d+)/)?.[1] || '';
  function ownLotsPage() {
    if (/^\/lots\/\d+\/trade/.test(location.pathname)) return true;
    const profile = location.pathname.match(/^\/users\/(\d+)/);
    return Boolean(profile && profile[1] === myId());
  }
  function setupLotButtons() {
    if (!ownLotsPage()) return;
    for (const item of $$('a.tc-item:not([data-px-lot])')) {
      const offerId = offerIdOf(item);
      if (!offerId) continue;
      item.dataset.pxLot = '1';
      const inactive = item.classList.contains('warning');
      const bar = el('span', 'px-lot-bar');
      const make = (text, title, action, cls = '') => {
        const button = el('button', 'px-lot-btn ' + cls, text); button.type = 'button'; button.title = title;
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(button); });
        return button;
      };
      bar.append(
        make(inactive ? '▶' : '⏸', inactive ? 'Активировать лот' : 'Деактивировать лот', button => toggleLot(item, offerId, button)),
        make('⧉', 'Дублировать лот (копия создаётся выключенной, без товаров автовыдачи)', button => duplicateLot(offerId, button)),
        make('🗑', 'Удалить лот', button => deleteLot(item, offerId, button), 'px-danger')
      );
      item.classList.add('px-lot');
      item.append(bar);
    }
  }
  async function busy(button, work) {
    if (button.disabled) return;
    const text = button.textContent; button.disabled = true; button.textContent = '…';
    try { await work(); } catch (error) { toast('Ошибка: ' + error.message, 'px-bad'); }
    finally { button.disabled = false; if (button.isConnected && button.textContent === '…') button.textContent = text; }
  }
  function toggleLot(item, offerId, button) {
    return busy(button, async () => {
      const fields = await offerFields(offerId);
      const turnOn = fields.active !== 'on';
      if (turnOn) fields.active = 'on'; else delete fields.active;
      await saveOffer(fields);
      item.classList.toggle('warning', !turnOn);
      button.textContent = turnOn ? '⏸' : '▶';
      button.title = turnOn ? 'Деактивировать лот' : 'Активировать лот';
      toast(turnOn ? 'Лот активирован' : 'Лот деактивирован');
    });
  }
  function duplicateLot(offerId, button) {
    return busy(button, async () => {
      if (!await confirmBox('Дублировать лот?', 'Будет создан такой же лот. Копия сохраняется выключенной и без товаров автовыдачи, чтобы один товар не продался дважды. Проверьте её и включите.', 'Дублировать')) return;
      const fields = await offerFields(offerId);
      fields.offer_id = '0';
      delete fields.active;
      if ('secrets' in fields) fields.secrets = '';
      delete fields.auto_delivery;
      await saveOffer(fields);
      toast('Копия лота создана, она выключена. Обновляю страницу…');
      setTimeout(() => location.reload(), 1200);
    });
  }
  function deleteLot(item, offerId, button) {
    return busy(button, async () => {
      const title = ($('.tc-desc-text', item)?.textContent || 'этот лот').trim().slice(0, 120);
      if (!await confirmBox('Удалить лот навсегда?', `«${title}». Это действие нельзя отменить.`, 'Удалить', true)) return;
      await saveOffer({ csrf_token: csrf(), offer_id: offerId, deleted: '1' });
      item.classList.add('px-removed');
      setTimeout(() => item.remove(), 400);
      toast('Лот удалён');
    });
  }

  // ---------- п.8: закрепление категорий в профиле ----------
  const PIN_KEY = 'projectx-pinned-categories';
  const pins = () => { try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch { return []; } };
  function setupPins() {
    if (!/^\/users\/\d+/.test(location.pathname)) return;
    const titles = $$('.offer-list-title-container');
    if (!titles.length) return;
    for (const title of titles) {
      if (title.dataset.pxPin) continue;
      const link = $('h3 a', title);
      const node = (link?.getAttribute('href') || '').match(/\/(lots|chips)\/(\d+)/)?.slice(1).join(':');
      if (!node) continue;
      title.dataset.pxPin = node;
      const button = el('button', 'px-pin', '📌'); button.type = 'button';
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        const list = pins(); const at = list.indexOf(node);
        if (at >= 0) list.splice(at, 1); else list.unshift(node);
        localStorage.setItem(PIN_KEY, JSON.stringify(list));
        orderPins();
      });
      ($('h3', title) || title).append(button);
    }
    orderPins();
  }
  function orderPins() {
    const list = pins();
    const blocks = $$('.offer-list-title-container').map(title => ({ node: title.dataset.pxPin, block: title.parentElement }));
    if (!blocks.length) return;
    const parent = blocks[0].block.parentElement;
    if (!parent) return;
    // Запоминаем исходный порядок, чтобы откреплённая категория вернулась на своё место.
    blocks.forEach((item, index) => { if (!item.block.dataset.pxOrder) item.block.dataset.pxOrder = String(index); });
    const sorted = [...blocks].sort((a, b) => {
      const pa = list.indexOf(a.node), pb = list.indexOf(b.node);
      if (pa >= 0 || pb >= 0) return (pa < 0 ? 1e9 : pa) - (pb < 0 ? 1e9 : pb);
      return Number(a.block.dataset.pxOrder) - Number(b.block.dataset.pxOrder);
    });
    const anchor = document.createComment('px');
    parent.insertBefore(anchor, blocks.map(b => b.block).sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1))[0]);
    for (const item of sorted) { parent.insertBefore(item.block, anchor); }
    anchor.remove();
    for (const item of blocks) {
      const pinned = list.includes(item.node);
      item.block.classList.toggle('px-pinned', pinned);
      const button = $(`.offer-list-title-container[data-px-pin="${item.node}"] .px-pin`);
      if (button) { button.classList.toggle('on', pinned); button.title = pinned ? 'Открепить категорию' : 'Закрепить категорию сверху'; }
    }
  }

  // ---------- п.5: последние покупки сверху в чате ----------
  function setupOrdersOrder() {
    if (!location.pathname.startsWith('/chat')) return;
    const scope = $$('.chat-detail-list, .chat-detail, .param-item, .chat-panel').filter(node => !node.closest('.chat-message-list, .chat-msg-item'));
    for (const area of scope) {
      const groups = new Map();
      for (const link of $$('a[href*="/orders/"]', area)) {
        let row = link;
        while (row.parentElement && row.parentElement !== area && $$('a[href*="/orders/"]', row.parentElement).length === 1) row = row.parentElement;
        const parent = row.parentElement;
        if (!parent) continue;
        if (!groups.has(parent)) groups.set(parent, []);
        if (!groups.get(parent).includes(row)) groups.get(parent).push(row);
      }
      for (const [parent, rows] of groups) {
        if (rows.length < 2) continue;
        const key = rows.map(r => r.textContent.trim()).join('|');
        if (parent.dataset.pxOrders === key) continue;
        // Упорядочиваем по номеру заказа в обратном порядке, если в ссылках он есть, иначе разворачиваем список.
        const reversed = [...rows].reverse();
        for (const row of reversed) parent.append(row);
        parent.dataset.pxOrders = reversed.map(r => r.textContent.trim()).join('|');
        parent.scrollTop = 0;
      }
    }
  }

  // ---------- /команды: «/1» в поле чата превращается в полный текст ----------
  // Список команд лаунчер кладёт рядом с расширением в commands.json (вкладка «/команды»).
  let snippets = [], snippetsAt = 0;
  async function loadSnippets(force) {
    if (!force && Date.now() - snippetsAt < 10000) return snippets;
    snippetsAt = Date.now();
    try {
      const response = await fetch(chrome.runtime.getURL('commands.json') + '?t=' + Date.now(), { cache: 'no-store' });
      const list = response.ok ? await response.json() : [];
      snippets = [];
      for (const item of Array.isArray(list) ? list : []) {
        for (const name of String(item.command || '').split('|').map(x => x.trim().toLowerCase()).filter(Boolean)) {
          snippets.push({ command: name, response: String(item.response || '') });
        }
      }
    } catch { /* команд пока нет */ }
    return snippets;
  }
  const chatField = target => target instanceof HTMLTextAreaElement && !target.closest('form.form-offer-editor')
    && (location.pathname.startsWith('/chat') || location.pathname.startsWith('/orders/') || target.closest('.chat-form, .chat-form-input, .chat'));
  function partnerName() {
    const link = $('.chat-header .media-user-name a') || $('.chat-header .media-user-name') || $('.chat-full-header .media-user-name');
    return (link?.textContent || '').trim();
  }
  function lastBuyerMessage() {
    const me = ($('.user-link-name')?.textContent || '').trim();
    const items = $$('.chat-msg-item');
    for (let i = items.length - 1; i >= 0; i--) {
      const author = ($('.chat-msg-author-link, .media-user-name', items[i])?.textContent || '').trim();
      if (author && author !== me) return ($('.chat-msg-text', items[i])?.textContent || '').trim();
    }
    return '';
  }
  // Последний заказ в этом чате: из сообщений FunPay «…заказ #ABCD1234…» или из ссылок на заказы справа.
  function lastOrderId() {
    const texts = $$('.chat-msg-text').map(node => node.textContent || '');
    for (let i = texts.length - 1; i >= 0; i--) {
      const found = texts[i].match(/#([A-Z0-9]{6,12})\b/g);
      if (found) return found[found.length - 1].slice(1);
    }
    const ids = $$('a[href*="/orders/"]').map(a => ((a.getAttribute('href') || '').match(/\/orders\/([A-Z0-9]{6,12})/) || [])[1]).filter(Boolean);
    return ids.length ? ids[ids.length - 1] : '';
  }
  function fillVariables(text) {
    const now = new Date();
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const pad = n => String(n).padStart(2, '0');
    const name = partnerName();
    const values = {
      '$full_date_text': `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()} года`,
      '$date_text': `${now.getDate()} ${months[now.getMonth()]}`,
      '$date': `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`,
      '$full_time': `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      '$time': `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      '$username': name, '$chat_name': name,
      '$chat_id': new URLSearchParams(location.search).get('node') || '',
      '$message_text': lastBuyerMessage(),
      '$order_id': '', '$order_link': ''
    };
    if (text.includes('$order_')) {
      const order = lastOrderId();
      values['$order_id'] = order ? '#' + order : '';
      values['$order_link'] = order ? 'https://funpay.com/orders/' + order + '/' : '';
    }
    // Длинные имена первыми, чтобы $date не съел начало $date_text.
    for (const key of Object.keys(values).sort((a, b) => b.length - a.length)) text = text.split(key).join(values[key]);
    return text;
  }
  function putText(field, text) {
    field.focus();
    field.value = text;
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  let menu = null, menuItems = [], menuIndex = 0, menuField = null;
  function closeMenu() { menu?.remove(); menu = null; menuItems = []; menuField = null; }
  function showMenu(field, items) {
    closeMenu();
    if (!items.length) return;
    menuField = field; menuItems = items; menuIndex = 0;
    menu = el('div', 'px-snip-menu');
    items.slice(0, 8).forEach((item, index) => {
      const row = el('div', 'px-snip-row' + (index === 0 ? ' on' : ''));
      row.append(el('b', '', '/' === item.command[0] ? item.command : item.command), el('span', '', item.response.replace(/\s+/g, ' ').slice(0, 90)));
      row.addEventListener('mousedown', event => { event.preventDefault(); putText(field, fillVariables(item.response)); closeMenu(); });
      menu.append(row);
    });
    const box = field.getBoundingClientRect();
    menu.style.left = Math.max(8, box.left) + 'px';
    menu.style.width = Math.min(520, Math.max(260, box.width)) + 'px';
    menu.style.bottom = (window.innerHeight - box.top + 6) + 'px';
    document.body.append(menu);
  }
  function highlight() { $$('.px-snip-row', menu).forEach((row, index) => row.classList.toggle('on', index === menuIndex)); }
  function setupSnippets() {
    if (document.documentElement.dataset.pxSnippets) return;
    document.documentElement.dataset.pxSnippets = '1';
    loadSnippets(true);
    document.addEventListener('focusin', event => { if (chatField(event.target)) loadSnippets(); });
    document.addEventListener('input', async event => {
      const field = event.target;
      if (!chatField(field)) return;
      const value = field.value.trim().toLowerCase();
      if (!value || value.includes('\n') || value.length > 40) { closeMenu(); return; }
      const list = await loadSnippets();
      const matches = list.filter(item => item.command.startsWith(value));
      if (!matches.length || (matches.length === 1 && matches[0].response === field.value)) { closeMenu(); return; }
      showMenu(field, matches.sort((a, b) => (a.command === value ? -1 : b.command === value ? 1 : a.command.length - b.command.length)));
    }, true);
    // Перехватываем Enter/Tab раньше FunPay: точное совпадение с командой подставляет текст вместо отправки.
    document.addEventListener('keydown', event => {
      const field = event.target;
      if (!chatField(field)) return;
      if (menu && menuField === field) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopImmediatePropagation();
          menuIndex = (menuIndex + (event.key === 'ArrowDown' ? 1 : -1) + Math.min(menuItems.length, 8)) % Math.min(menuItems.length, 8);
          highlight(); return;
        }
        if (event.key === 'Escape') { closeMenu(); return; }
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        const value = field.value.trim().toLowerCase();
        const exact = snippets.find(item => item.command === value);
        const pick = menu && menuField === field ? menuItems[menuIndex] : exact;
        if (!pick || (event.key === 'Enter' && !exact && !menu)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        putText(field, fillVariables(pick.response));
        closeMenu();
      }
    }, true);
    document.addEventListener('focusout', () => setTimeout(() => { if (menu && document.activeElement !== menuField) closeMenu(); }, 150));
  }

  // ---------- п.12: копирование слова двойным кликом ----------
  function setupCopyWord() {
    if (document.documentElement.dataset.pxCopy) return;
    document.documentElement.dataset.pxCopy = 'ext';
    document.addEventListener('dblclick', event => {
      if (event.target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], button, a, select')) return;
      const text = String(window.getSelection()).trim();
      if (!text || text.length > 200) return;
      navigator.clipboard.writeText(text).then(() => toast('Скопировано: ' + (text.length > 40 ? text.slice(0, 39) + '…' : text)), () => { if (document.execCommand('copy')) toast('Скопировано'); });
    });
  }

  function tick() {
    try { setupBuyerPrice(); } catch (e) { console.warn('ProjectX buyer price', e); }
    try { setupLotButtons(); } catch (e) { console.warn('ProjectX lots', e); }
    try { setupPins(); } catch (e) { console.warn('ProjectX pins', e); }
    try { setupOrdersOrder(); } catch (e) { console.warn('ProjectX orders', e); }
  }
  function start() {
    setupCopyWord();
    setupSnippets();
    tick();
    let pending = false;
    new MutationObserver(() => { if (pending) return; pending = true; setTimeout(() => { pending = false; tick(); }, 300); })
      .observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();

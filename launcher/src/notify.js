'use strict';
// Находит в выводе бота события для уведомлений и звуков:
// сообщение, заказ, подтверждение, отзыв, поднятие лотов, выдача товара, ошибка выдачи.
const NEW_MESSAGE = /Новое сообщение в переписке с пользователем\s+(.+?)\s*\(CID: (\d+)\)/;
const MESSAGE_HEAD = /└───>\s*([^:]+):\s?(.*)$/;
const MESSAGE_MORE = /^\[[^\]]*\]>\s*\w?:?\s{4,}(.*)$/;
const NEW_ORDER = /Новый заказ! ID:\s*#?([A-Z0-9]+)/i;
const RAISED = /Все лоты категории\s+"?(.+?)"?\s+подняты!/;
const DELIVERED = /Товар для заказа\s+#?([A-Z0-9]+)\s+выдан/i;
const DELIVERY_FAILED = /Не удалось отправить товар для ордера\s+#?([A-Z0-9]+)/i;
const PAID = /оплатил[а]? заказ\s+#([A-Z0-9]+)\.?\s*(.*)$/i;

const short = (text, size = 140) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > size ? t.slice(0, size - 1) + '…' : t; };

class NotifyDetector {
  constructor({ emit, me = () => '', delay = 1500 }) {
    this.emit = emit; this.me = me; this.delay = delay;
    this.pending = null; this.head = null; this.timer = null; this.lastStrong = 0;
    this.paid = new Map(); this.orders = new Map();
  }

  line(text) {
    let m;
    if ((m = NEW_ORDER.exec(text))) return this.order(m[1]);
    if ((m = RAISED.exec(text))) return this.emit({ kind: 'raise', title: 'Лоты подняты', text: m[1] });
    if ((m = DELIVERED.exec(text))) return this.emit({ kind: 'delivered', title: 'Товар выдан', text: 'Заказ #' + m[1], order: m[1] });
    if ((m = DELIVERY_FAILED.exec(text))) return this.emit({ kind: 'error', title: 'Не удалось выдать товар', text: 'Заказ #' + m[1], order: m[1] });
    if ((m = NEW_MESSAGE.exec(text))) { this.head = { chat: m[1], chatId: m[2], open: false }; return; }
    if (!this.head) return;
    if (!this.head.open) {
      if (!(m = MESSAGE_HEAD.exec(text))) return;
      this.head.open = true;
      return this.message(m[1].trim(), m[2]);
    }
    // Продолжение многострочного сообщения дописываем к уже ожидающему уведомлению.
    if ((m = MESSAGE_MORE.exec(text)) && this.pending && this.pending.chatId === this.head.chatId) this.pending.text = short(this.pending.text + ' ' + m[1]);
    else this.head = null;
  }

  message(author, body) {
    const { chat, chatId } = this.head;
    const me = String(this.me() || '').trim().toLowerCase();
    if (me && author.toLowerCase() === me) return; // своё сообщение или ответ бота
    if (author === 'FunPay') {
      let m;
      if (/подтвердил[а]? успешное выполнение заказа/i.test(body)) return this.strong({ kind: 'confirm', title: 'Заказ подтверждён', text: short(body), chat, chatId });
      if (/(написал|оставил|изменил)[а]? отзыв/i.test(body)) return this.strong({ kind: 'review', title: 'Новый отзыв', text: short(body), chat, chatId });
      if ((m = PAID.exec(body))) { this.paid.set(m[1], { chat, chatId, text: m[2] }); this.fillOrder(m[1]); return; }
    }
    this.soft({ kind: 'message', title: author, text: short(body), chat, chatId });
  }

  // О заказе сообщаем через секунду: за это время обычно приходит сообщение FunPay с названием лота.
  order(id) {
    this.lastStrong = Date.now();
    this.dropPending();
    const event = { kind: 'order', title: 'Новый заказ #' + id, text: '', order: id };
    this.orders.set(id, event);
    this.fillOrder(id);
    setTimeout(() => { this.orders.delete(id); this.emit(event); }, Math.min(this.delay, 1000));
  }
  fillOrder(id) {
    const event = this.orders.get(id), paid = this.paid.get(id);
    if (!event || !paid) return;
    event.text = short(paid.text.replace(/Покупатель .*?, не забудьте.*$/i, '').trim() || paid.chat);
    event.chat = paid.chat; event.chatId = paid.chatId;
  }

  strong(event) { this.lastStrong = Date.now(); this.dropPending(); this.emit(event); }

  soft(event) {
    if (Date.now() - this.lastStrong < this.delay) return;
    if (this.pending) {
      if (this.pending.chatId === event.chatId) { this.pending.count = (this.pending.count || 1) + 1; this.pending.text = event.text; }
      else { clearTimeout(this.timer); this.flush(); this.pending = event; this.arm(); }
      return;
    }
    this.pending = event; this.arm();
  }
  arm() { this.timer = setTimeout(() => this.flush(), this.delay); }
  flush() { const event = this.pending; this.pending = null; if (event) this.emit(event); }
  dropPending() { clearTimeout(this.timer); this.pending = null; }

  reset() { this.dropPending(); this.head = null; this.paid.clear(); }
}

module.exports = { NotifyDetector };

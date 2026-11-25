"""
Напоминания покупателю: подтвердить заказ и оставить отзыв.

Две независимые функции (настройки в [BuyerReminders] файла configs/_main.cfg, правятся из лаунчера,
раздел «Функции» → «Сообщения покупателям»):
  * «Напоминание о подтверждении»: заказ оплачен, но не подтверждён — до 3 сообщений через
    confirmDelay1..3 минут после оплаты;
  * «Напоминание об отзыве»: заказ подтверждён, отзыва нет — до 3 сообщений через reviewDelay1..3 минут
    после подтверждения.
Таймер 0 отключает этот шаг. Напоминания прекращаются, как только заказ подтверждён / оставлен отзыв /
сделан возврат. Перед каждой отправкой статус заказа и наличие отзыва проверяются на FunPay.
Состояние хранится в sqlite (storage/plugins/buyer_reminders), повторов после перезапуска нет.
Если бот был выключен и пропущено несколько шагов, отправляется только последний наступивший.
Настройки перечитываются из файла раз в минуту, перезапуск бота не нужен.

В тексте доступны: $username, $order_id, $order_link, $order_title.
"""
from __future__ import annotations

import configparser
import logging
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from threading import Lock, Thread

from FunPayAPI.common.enums import MessageTypes, OrderStatuses

NAME = "Напоминания покупателю"
VERSION = "1.1.0"
DESCRIPTION = ("Мягко напоминает покупателю подтвердить заказ и оставить отзыв (до 3 раз, свои таймеры). "
               "Настройки — в лаунчере: Плагины → Напоминания покупателю.")
CREDITS = "Claude"
SETTINGS_PAGE = False
UUID = "2c62921b-dd65-43d9-947a-ee85702bf4ca"
BIND_TO_DELETE = None

logger = logging.getLogger("FPC.buyer_reminders")
PREFIX = "[BuyerReminders]"

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "configs" / "_main.cfg"
DATA = ROOT / "storage" / "plugins" / "buyer_reminders"
SECTION = "BuyerReminders"
TICK = 60
STEPS = 3
KEEP_DAYS = 14  # после этого заказ перестаёт отслеживаться

DEFAULTS = {
    "confirmEnabled": "0", "confirmCount": "3",
    "confirmDelay1": "10", "confirmDelay2": "60", "confirmDelay3": "320",
    "confirmText1": "Здравствуйте, $username! Если с заказом #$order_id всё в порядке, пожалуйста, "
                    "подтвердите его выполнение:$order_link",
    "confirmText2": "$username, напоминаю: заказ #$order_id ждёт вашего подтверждения. "
                    "Если что-то не так — напишите, разберёмся!",
    "confirmText3": "Не забудьте, пожалуйста, подтвердить заказ #$order_id, если всё получили: $order_link. "
                    "Спасибо!",
    "reviewEnabled": "0", "reviewCount": "3",
    "reviewDelay1": "60", "reviewDelay2": "360", "reviewDelay3": "1440",
    "reviewText1": "Спасибо за покупку, $username! Будем очень благодарны за отзыв к заказу #$order_id: "
                   "$order_link",
    "reviewText2": "$username, если вам всё понравилось, оставьте, пожалуйста, пару слов в отзыве — "
                   "это нам очень помогает: $order_link",
    "reviewText3": "Последнее напоминание: отзыв к заказу #$order_id можно оставить здесь: $order_link. "
                   "Спасибо, что выбрали нас!",
}

ORDER_ID = re.compile(r"#([A-Z0-9]{8})")
CONFIRMED_TYPES = (MessageTypes.ORDER_CONFIRMED, MessageTypes.ORDER_CONFIRMED_BY_ADMIN)
REVIEW_TYPES = (MessageTypes.NEW_FEEDBACK, MessageTypes.FEEDBACK_CHANGED)

# phase: paid (ждём подтверждения) → confirmed (ждём отзыв) → done
SCHEMA = """CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY, chat_id TEXT, buyer TEXT, title TEXT,
    phase TEXT NOT NULL, paid_ts REAL, confirmed_ts REAL,
    confirm_sent INTEGER NOT NULL DEFAULT 0, review_sent INTEGER NOT NULL DEFAULT 0,
    updated_ts REAL)"""

_lock = Lock()
_db_path: Path | None = None


def _db():
    db = sqlite3.connect(_db_path, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def _settings(c) -> dict:
    """Читает [BuyerReminders] из файла (его меняет лаунчер) и синхронизирует в память Кардинала,
    чтобы сохранение конфига из Telegram не затёрло значения."""
    values = dict(DEFAULTS)
    try:
        parser = configparser.ConfigParser(delimiters=(":",), interpolation=None)
        parser.optionxform = str
        parser.read(CFG_PATH, encoding="utf-8")
        if parser.has_section(SECTION):
            values.update(parser[SECTION])
    except Exception as e:
        logger.warning(f"{PREFIX} Не удалось прочитать настройки: {e}")
        if c.MAIN_CFG.has_section(SECTION):
            values.update(c.MAIN_CFG[SECTION])
        return values
    try:
        if not c.MAIN_CFG.has_section(SECTION):
            c.MAIN_CFG.add_section(SECTION)
        for k, v in values.items():
            c.MAIN_CFG[SECTION][k] = v
    except Exception:
        pass
    return values


def _ensure_defaults(c) -> None:
    """Дописывает секцию с настройками по умолчанию, если её нет (чтобы лаунчер их показал)."""
    parser = configparser.ConfigParser(delimiters=(":",), interpolation=None)
    parser.optionxform = str
    parser.read(CFG_PATH, encoding="utf-8")
    missing = {k: v for k, v in DEFAULTS.items() if not (parser.has_section(SECTION) and k in parser[SECTION])}
    if not missing:
        return
    # Дописываем только недостающее, не переписывая весь файл.
    text = CFG_PATH.read_text(encoding="utf-8")
    eol = "\r\n" if "\r\n" in text else "\n"
    rendered = [f"{k} : {v}" for k, v in missing.items()]
    if not parser.has_section(SECTION):
        text = text.rstrip("\r\n") + eol + eol + f"[{SECTION}]" + eol + eol.join(rendered) + eol
    else:
        lines = text.split(eol)
        start = next(i for i, l in enumerate(lines) if l.strip() == f"[{SECTION}]")
        end = start + 1
        while end < len(lines) and not lines[end].startswith("["):
            end += 1
        while end > start + 1 and not lines[end - 1].strip():
            end -= 1
        lines[end:end] = rendered
        text = eol.join(lines)
    tmp = CFG_PATH.with_suffix(".cfg.reminders.tmp")
    tmp.write_text(text, encoding="utf-8", newline="")
    tmp.replace(CFG_PATH)
    logger.info(f"{PREFIX} Добавлены настройки по умолчанию в [{SECTION}] _main.cfg.")


def _delays(values: dict, kind: str) -> list[float | None]:
    result = []
    try:
        count = min(STEPS, max(1, int(values.get(f"{kind}Count", STEPS))))
    except ValueError:
        count = STEPS
    for i in range(1, count + 1):
        try:
            minutes = float(values.get(f"{kind}Delay{i}", "0") or 0)
        except ValueError:
            minutes = 0
        result.append(minutes * 60 if minutes > 0 else None)
    return result


# ---------- состояние ----------

def _upsert_paid(order_id, chat_id, buyer, title):
    with _lock, closing(_db()) as db, db:
        db.execute("""INSERT INTO orders(order_id, chat_id, buyer, title, phase, paid_ts, updated_ts)
                      VALUES (?, ?, ?, ?, 'paid', ?, ?) ON CONFLICT(order_id) DO NOTHING""",
                   (order_id, str(chat_id), buyer, title, time.time(), time.time()))


def _mark_confirmed(order_id, chat_id=None, buyer=None, title=None, ts=None):
    ts = ts or time.time()
    with _lock, closing(_db()) as db, db:
        row = db.execute("SELECT phase FROM orders WHERE order_id=?", (order_id,)).fetchone()
        if row is None:
            if chat_id is None:
                return
            db.execute("""INSERT INTO orders(order_id, chat_id, buyer, title, phase, confirmed_ts, updated_ts)
                          VALUES (?, ?, ?, ?, 'confirmed', ?, ?)""",
                       (order_id, str(chat_id), buyer, title, ts, ts))
        elif row["phase"] == "paid":
            db.execute("UPDATE orders SET phase='confirmed', confirmed_ts=?, updated_ts=? WHERE order_id=?",
                       (ts, time.time(), order_id))


def _mark_done(order_id, reason):
    with _lock, closing(_db()) as db, db:
        cur = db.execute("UPDATE orders SET phase='done', updated_ts=? WHERE order_id=? AND phase!='done'",
                         (time.time(), order_id))
    if cur.rowcount:
        logger.debug(f"{PREFIX} #{order_id}: напоминания остановлены ({reason}).")


def _mark_reopened(order_id):
    with _lock, closing(_db()) as db, db:
        db.execute("UPDATE orders SET phase='paid', updated_ts=? WHERE order_id=? AND phase='confirmed'",
                   (time.time(), order_id))


# ---------- события ----------

def on_new_order(c, event):
    o = event.order
    if o.status == OrderStatuses.PAID:
        _upsert_paid(o.id, o.chat_id, o.buyer_username, o.description)


def on_status_changed(c, event):
    o = event.order
    if o.status == OrderStatuses.CLOSED:
        _mark_confirmed(o.id, o.chat_id, o.buyer_username, o.description)
    elif o.status == OrderStatuses.REFUNDED:
        _mark_done(o.id, "возврат")
    elif o.status == OrderStatuses.PAID:
        _mark_reopened(o.id)


def on_new_message(c, event):
    msg = event.message
    if msg.type in (None, MessageTypes.NON_SYSTEM):
        return
    m = ORDER_ID.search(msg.text or "")
    if not m:
        return
    order_id = m.group(1)
    if msg.type in CONFIRMED_TYPES:
        _mark_confirmed(order_id, msg.chat_id, msg.chat_name, None)
    elif msg.type in REVIEW_TYPES:
        _mark_done(order_id, "отзыв")
    elif msg.type == MessageTypes.REFUND:
        _mark_done(order_id, "возврат")
    elif msg.type == MessageTypes.ORDER_REOPENED:
        _mark_reopened(order_id)


# ---------- цикл напоминаний ----------

def _render(template: str, row) -> str:
    order_id = row["order_id"]
    return (template.replace("$order_link", f"https://funpay.com/orders/{order_id}/")
            .replace("$order_id", order_id)
            .replace("$username", row["buyer"] or "")
            .replace("$order_title", row["title"] or ""))


def _due_step(delays, sent, start_ts, now):
    """Последний наступивший и ещё не отправленный шаг (индекс) или None."""
    if start_ts is None:
        return None
    due = None
    for i, d in enumerate(delays):
        if d is not None and i >= sent and now >= start_ts + d:
            due = i
    return due


def _process(c, row, values, now):
    order_id = row["order_id"]
    kind = "confirm" if row["phase"] == "paid" else "review"
    if values.get(f"{kind}Enabled") != "1":
        return
    delays = _delays(values, kind)
    sent = row[f"{kind}_sent"]
    start_ts = row["paid_ts"] if kind == "confirm" else row["confirmed_ts"]
    step = _due_step(delays, sent, start_ts, now)
    if step is None:
        return

    # Проверяем актуальное состояние заказа на FunPay.
    try:
        order = c.account.get_order(order_id)
    except Exception as e:
        logger.warning(f"{PREFIX} #{order_id}: не удалось получить заказ ({e}), повторю позже.")
        return
    if order.status == OrderStatuses.REFUNDED:
        return _mark_done(order_id, "возврат")
    if order.review is not None and (order.review.stars or order.review.text):
        return _mark_done(order_id, "отзыв")
    if kind == "confirm" and order.status == OrderStatuses.CLOSED:
        return _mark_confirmed(order_id, ts=now)  # отзыв — по своим таймерам, от этого момента
    if kind == "review" and order.status == OrderStatuses.PAID:
        return _mark_reopened(order_id)

    text = (values.get(f"{kind}Text{step + 1}") or "").strip() or DEFAULTS[f"{kind}Text{step + 1}"]
    # Сначала фиксируем отправку: лучше пропустить напоминание, чем отправить его дважды.
    with _lock, closing(_db()) as db, db:
        db.execute(f"UPDATE orders SET {kind}_sent=?, updated_ts=? WHERE order_id=?", (step + 1, now, order_id))
    row = dict(row)
    row["buyer"] = row["buyer"] or order.buyer_username
    chat_id = row["chat_id"] or order.chat_id
    if isinstance(chat_id, str) and chat_id.isdigit():
        chat_id = int(chat_id)
    result = c.send_message(chat_id, _render(text, row), row["buyer"], watermark=False)
    label = "подтверждении" if kind == "confirm" else "отзыве"
    if result:
        logger.info(f"{PREFIX} #{order_id}: отправлено напоминание о {label} №{step + 1} ({row['buyer']}).")
    else:
        logger.warning(f"{PREFIX} #{order_id}: не удалось отправить напоминание о {label} №{step + 1}.")


def _reconcile(c):
    """После запуска сверяет незавершённые заказы с первой страницей продаж (события, пропущенные офлайн)."""
    try:
        sales = c.account.get_sales()[1]
    except Exception as e:
        logger.warning(f"{PREFIX} Сверка с продажами не удалась: {e}")
        return
    with _lock, closing(_db()) as db:
        active = {r["order_id"]: r["phase"] for r in db.execute("SELECT order_id, phase FROM orders WHERE phase!='done'")}
    for o in sales:
        phase = active.get(o.id)
        if phase is None:
            continue
        if o.status == OrderStatuses.REFUNDED:
            _mark_done(o.id, "возврат")
        elif o.status == OrderStatuses.CLOSED and phase == "paid":
            _mark_confirmed(o.id)


def _loop(c):
    _reconcile(c)
    while True:
        try:
            values = _settings(c)
            now = time.time()
            with _lock, closing(_db()) as db, db:
                db.execute("UPDATE orders SET phase='done' WHERE phase!='done' AND "
                           "COALESCE(confirmed_ts, paid_ts, updated_ts) < ?", (now - KEEP_DAYS * 86400,))
                rows = db.execute("SELECT * FROM orders WHERE phase IN ('paid', 'confirmed')").fetchall()
            for row in rows:
                try:
                    _process(c, row, values, now)
                except Exception:
                    logger.exception(f"{PREFIX} Ошибка обработки #{row['order_id']}")
        except Exception:
            logger.exception(f"{PREFIX} Ошибка цикла напоминаний")
        time.sleep(TICK)


def _init_db(c) -> bool:
    global _db_path
    if _db_path is not None:
        return True
    account_id = getattr(c.account, "id", None)
    if not account_id:
        return False
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / f"reminders-{account_id}.sqlite3"
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        db.execute(SCHEMA)
    _db_path = path
    return True


def start(c):
    if not _init_db(c):
        logger.error(f"{PREFIX} Аккаунт не инициализирован, напоминания не запущены.")
        return
    try:
        _ensure_defaults(c)
    except Exception as e:
        logger.warning(f"{PREFIX} Не удалось записать настройки по умолчанию: {e}")
    _settings(c)
    Thread(target=_loop, args=(c,), name="BuyerReminders", daemon=True).start()
    logger.info(f"{PREFIX} Напоминания покупателю запущены.")


def _guard(fn):
    def wrapper(c, event):
        if not _init_db(c):
            return
        try:
            fn(c, event)
        except Exception:
            logger.exception(f"{PREFIX} Ошибка в обработчике {fn.__name__}")
    wrapper.__name__ = fn.__name__
    return wrapper


BIND_TO_POST_START = [start]
BIND_TO_NEW_ORDER = [_guard(on_new_order)]
BIND_TO_ORDER_STATUS_CHANGED = [_guard(on_status_changed)]
BIND_TO_NEW_MESSAGE = [_guard(on_new_message)]

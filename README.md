# ProjectX — дистрибутив для FunPay

Лёгкий лаунчер (Electron) + ядро FunPay Cardinal. Пользователь скачивает маленький `ProjectX-FunPay.exe`, при первом запуске он сам докачивает ядро, а дальше обновляется с GitHub.

## Структура репозитория

```
launcher/     твой лаунчер (Electron). exe собирается отсюда
  src/            код лаунчера (обфусцируется при релизе)
  assets/         иконки
  extension/      встроенное расширение
  scripts/        обфускация, установка иконки, запись update-config
  update-config.json  куда ходить за обновлениями (заполняется при сборке)
core/         ядро FunPay Cardinal (Python) — чистое, без чужих данных
  configs/        только шаблоны (telegram_gift.toml), без секретов
  storage/ logs/  пустые (.gitkeep)
  VERSION         версия ядра для манифеста
build/
  make-release.js пакует exe + zip ядра/лаунчера + latest.json
.github/workflows/release.yml  сборка и публикация релиза
```

## Как это работает

- **Первый запуск.** Рядом с exe нет ядра → лаунчер качает `core-<ver>.zip` из последнего релиза и распаковывает в `FunPayCardinal-main`. Пользователь вводит свой `golden_key` в «Первой настройке».
- **Автообновление лаунчера.** На старте лаунчер читает `latest.json` из релиза `latest`. Если версия новее — качает `launcher-src-<ver>.zip` и кладёт `src/` + `package.json` рядом с exe. `boot.js` подхватывает новую папку при следующем запуске (exe пересобирать не нужно).
- **Адрес обновлений** — в `launcher/update-config.json` (можно сменить без пересборки) и во вшитой копии `src/update-config.json`.

## Выпуск новой версии

1. Поднять версию в `launcher/package.json` (лаунчер) и/или `core/VERSION` (ядро).
2. `git tag v0.7.7 && git push origin v0.7.7`.
3. Actions соберёт exe, обфусцирует код, спакует ассеты и опубликует релиз с `latest.json`.

Локально: `cd launcher && npm ci && npm run obfuscate && npm run build && node ../build/make-release.js --repo owner/repo --tag v0.7.7`.

## Безопасность

- В репозитории и релизах **нет** личных данных: `golden_key`, токен Telegram-бота, `.session`, базы заказов/отзывов и товары вырезаны. `.gitignore` страхует от случайного коммита секретов.
- Каждый пользователь вводит свой `golden_key` при первой настройке; данные хранятся только у него на машине.

## Лицензия / авторство

Ядро основано на открытом коде FunPay Cardinal (автор — sidor0912). Автор дал разрешение на модификацию и распространение.

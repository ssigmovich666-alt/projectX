'use strict';
// Команды автоответчика бота: configs/auto_response.cfg.
// Формат — configparser с разделителем ":": [команда] и параметры response, enabled, telegramNotification, notificationText.
// Несколько вариантов одной команды пишутся через "|": [привет|hi]. Бот сравнивает команду в нижнем регистре.
const fs = require('node:fs/promises');
const path = require('node:path');

const file = botDir => path.join(botDir, 'configs', 'auto_response.cfg');

// Переменные, которые бот подставляет в ответ (Utils/cardinal_tools.py, format_msg_text).
const VARIABLES = [
  ['$username', 'Имя покупателя.'],
  ['$message_text', 'Текст его сообщения.'],
  ['$chat_name', 'Название чата.'],
  ['$chat_id', 'ID чата.'],
  ['$date', 'Дата, 21.11.2026.'],
  ['$date_text', 'Дата словами, 21 ноября.'],
  ['$full_date_text', '21 ноября 2026 года.'],
  ['$time', 'Время, 16:40.'],
  ['$full_time', 'Время с секундами.'],
  ['$order_id', 'Номер последнего заказа в чате, #ABCD1234.'],
  ['$order_link', 'Ссылка на этот заказ.']
];

function parse(source) {
  const commands = [];
  let current = null, key = null;
  for (const raw of source.replace(/^﻿/, '').split(/\r?\n/)) {
    const section = /^\[(.+)\]\s*$/.exec(raw);
    if (section) { current = { command: section[1], response: '', enabled: true, telegram: false, notification: '' }; commands.push(current); key = null; continue; }
    if (!current) continue;
    if (/^\s+\S/.test(raw) || (/^\s*$/.test(raw) && key === 'response')) {
      if (key === 'response') current.response += '\n' + raw.trim();
      else if (key === 'notification') current.notification += '\n' + raw.trim();
      continue;
    }
    if (/^\s*[#;]/.test(raw)) continue;
    const pair = /^([^:]+?)\s*:\s?(.*)$/.exec(raw);
    if (!pair) { key = null; continue; }
    const [, name, value] = pair;
    key = null;
    if (name === 'response') { current.response = value.trim(); key = 'response'; }
    else if (name === 'enabled') current.enabled = value.trim() !== '0';
    else if (name === 'telegramNotification') current.telegram = value.trim() === '1';
    else if (name === 'notificationText') { current.notification = value.trim(); key = 'notification'; }
  }
  for (const item of commands) { item.response = item.response.replace(/\n+$/, ''); item.notification = item.notification.replace(/\n+$/, ''); }
  return commands;
}

async function readCommands(botDir) {
  let source = '';
  try { source = await fs.readFile(file(botDir), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { commands: parse(source), variables: VARIABLES };
}

const multiline = text => String(text).replace(/\r/g, '').split('\n').map((line, index) => index ? '\t' + line : line).join('\n');

function validate(list) {
  if (!Array.isArray(list) || list.length > 500) throw new Error('Неверный список команд.');
  const seen = new Set();
  return list.map((item, index) => {
    const command = String(item?.command ?? '').trim().toLowerCase().replace(/\s*\|\s*/g, '|');
    const response = String(item?.response ?? '').replace(/\r/g, '').trim();
    const where = `Команда №${index + 1}`;
    if (!command) throw new Error(`${where}: пустая команда.`);
    if (/[\[\]\n]/.test(command)) throw new Error(`${where}: в команде нельзя использовать [ ] и перенос строки.`);
    if (!response) throw new Error(`${where} (${command}): пустой ответ.`);
    for (const part of command.split('|').map(x => x.trim()).filter(Boolean)) {
      if (seen.has(part)) throw new Error(`Команда «${part}» указана дважды.`);
      seen.add(part);
    }
    return { command, response, enabled: item?.enabled !== false, telegram: item?.telegram === true, notification: String(item?.notification ?? '').replace(/\r/g, '').trim() };
  });
}

function serialize(list) {
  return list.map(item => {
    const lines = [`[${item.command}]`, `response: ${multiline(item.response)}`, `enabled: ${item.enabled ? 1 : 0}`, `telegramNotification: ${item.telegram ? 1 : 0}`];
    if (item.notification) lines.push(`notificationText: ${multiline(item.notification)}`);
    return lines.join('\n');
  }).join('\n\n') + (list.length ? '\n' : '');
}

let backedUp = new Set();
async function saveCommands(botDir, list) {
  const clean = validate(list);
  const target = file(botDir);
  if (!backedUp.has(botDir)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    try { await fs.copyFile(target, path.join(botDir, 'configs', `auto_response-before-launcher-${stamp}.cfg.bak`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    backedUp.add(botDir);
  }
  const temporary = target + '.tmp';
  await fs.writeFile(temporary, serialize(clean), 'utf8');
  await fs.rename(temporary, target);
  return readCommands(botDir);
}

module.exports = { readCommands, saveCommands, parse, serialize, validate, VARIABLES };

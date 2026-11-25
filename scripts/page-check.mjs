#!/usr/bin/env node
// Opens a throwaway inbox in headless Chrome (never a window), waits until the
// page has drawn its tabs, and prints what a person would read: the tabs, the
// sidebar settings and the languages offered. With --shot FILE it also saves a
// screenshot. Chrome's own language is Turkish here on purpose, to prove the
// page does not follow it.
//
// With --item N it first posts three items and opens the page at /#N, then prints
// the row numbers and which row the link opened.
//
// Usage: node scripts/page-check.mjs [--shot out.png] [--dark] [--width 1280] [--item 2]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { shot: { type: 'string' }, dark: { type: 'boolean' }, width: { type: 'string', default: '1280' }, item: { type: 'string' } } });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'askito-page-'));
const port = 46000 + Math.floor(Math.random() * 2000);
const debugPort = 48000 + Math.floor(Math.random() * 2000);
const env = { ...process.env, ASKITO_HOME: path.join(work, 'home'), ASKITO_PORT: String(port), ASKITO_NO_NOTIFY: '1' };
const askito = (...args) => execFileSync(process.execPath, [path.join(root, 'bin', 'askito.js'), ...args], { env, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
async function main() {
  askito('start');
  if (values.item) {
    for (const title of ['First question', 'Second question', 'Third question']) askito('ask', title, '--project', 'demo');
  }
  const url = askito('open', ...(values.item ? [values.item] : []), '--url');
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--lang=tr-TR', `--user-data-dir=${path.join(work, 'chrome')}`, `--remote-debugging-port=${debugPort}`, `--window-size=${values.width},900`, 'about:blank'], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 50 && !target; i += 1) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json()).then((list) => list.find((t) => t.type === 'page')).catch(() => null);
  }
  if (!target) throw new Error('headless Chrome did not start');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;

  if (values.dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.navigate', { url });
  let drawn = false;
  for (let i = 0; i < 75 && !drawn; i += 1) {
    await sleep(200);
    drawn = await evaluate("document.querySelectorAll('[role=tab]').length > 0");
  }
  if (!drawn) throw new Error('the page did not draw its tabs within 15 seconds');

  const seen = await evaluate(`({
    tabs: [...document.querySelectorAll('[role=tab]')].map((el) => el.textContent),
    settings: [...document.querySelectorAll('.side-foot label')].map((el) => el.firstChild.textContent),
    offered: [...document.querySelectorAll('.side-foot label select')].map((el) => [...el.options].map((o) => o.textContent)),
    lang: document.documentElement.lang,
  })`);
  console.log(`page language: ${seen.lang}`);
  console.log(`tabs: ${seen.tabs.join(', ')}`);
  seen.settings.forEach((name, index) => console.log(`${name}: ${seen.offered[index].join(', ')}`));

  if (values.item) {
    await sleep(300);
    const rows = await evaluate(`({
      numbers: [...document.querySelectorAll('.row-num')].map((el) => el.textContent),
      open: document.querySelector('.row.is-open .row-num')?.textContent ?? 'none',
      openTitle: document.querySelector('.row.is-open .row-head')?.textContent ?? '',
      focused: document.activeElement?.closest('.row')?.querySelector('.row-num')?.textContent ?? 'none',
      address: location.pathname + location.hash,
    })`);
    console.log(`rows: ${rows.numbers.join(', ')}`);
    console.log(`opened by the link: ${rows.open} (${rows.openTitle.slice(0, 60)})`);
    console.log(`focused: ${rows.focused}`);
    console.log(`address after opening: ${rows.address}`);
  }

  if (values.shot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(values.shot, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${values.shot}`);
  }
  socket.close();
}

try {
  await main();
} catch (err) {
  console.error(`page check failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  browser?.kill();
  try {
    askito('stop');
  } catch {
    // Already stopped.
  }
  fs.rmSync(work, { recursive: true, force: true });
}

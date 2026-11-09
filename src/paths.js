import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 4517;

export function homeDir() {
  return process.env.ASKITO_HOME || path.join(os.homedir(), '.askito');
}

export function filePath(name) {
  return path.join(homeDir(), name);
}

export function ensureHome() {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(filePath('config.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  ensureHome();
  fs.writeFileSync(filePath('config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function getPort() {
  return Number(process.env.ASKITO_PORT || readConfig().port || DEFAULT_PORT);
}

// Two separate secrets: agents get one, the browser gets the other. Answer
// routes accept only the browser secret, so an agent calling the API with its
// own token cannot approve its own request.
function readOrCreateToken(name) {
  ensureHome();
  const file = filePath(name);
  try {
    fs.writeFileSync(file, randomBytes(24).toString('hex'), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export function agentToken() {
  return readOrCreateToken('agent.token');
}

export function uiToken() {
  return readOrCreateToken('ui.token');
}

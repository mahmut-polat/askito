import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, stopServer } from './client.js';
import { homeDir, PACKAGE_ROOT, readConfig, writeConfig } from './paths.js';
import { FIRST_RUN_KEY } from './store.js';

const MD_START = '<!-- askito:start -->';
const MD_END = '<!-- askito:end -->';
const TOML_START = '# askito:start';
const TOML_END = '# askito:end';
const APP_PARTS = ['bin', 'src', 'web', 'skill', 'plugins', '.claude-plugin', 'package.json'];
const isWindows = process.platform === 'win32';

const home = () => process.env.HOME || process.env.USERPROFILE || os.homedir();
const inHome = (...parts) => path.join(home(), ...parts);
const appDir = () => path.join(homeDir(), 'app');
const shimPath = () => path.join(homeDir(), 'bin', isWindows ? 'askito.cmd' : 'askito');

function vscodeUserDir(product = 'Code') {
  if (process.platform === 'darwin') return inHome('Library', 'Application Support', product, 'User');
  if (isWindows) return path.join(process.env.APPDATA ?? inHome('AppData', 'Roaming'), product, 'User');
  return inHome('.config', product, 'User');
}

function onPath(binary) {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && (fs.existsSync(path.join(dir, binary)) || fs.existsSync(path.join(dir, `${binary}.cmd`))));
}

const exists = (...candidates) => candidates.some((p) => fs.existsSync(p));

// Only paths confirmed against each vendor's current docs belong here. A tool
// without a confirmed path gets the plain command line rules through
// `askito instructions`, because writing a guessed file helps nobody.
function adapters() {
  const code = vscodeUserDir();
  const ext = (id) => path.join(code, 'globalStorage', id, 'settings');
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      detect: () => onPath('claude') || exists(inHome('.claude')),
      mcp: { file: inHome('.claude.json'), key: 'mcpServers', cli: 'claude' },
      skills: [inHome('.claude', 'skills')],
      rules: inHome('.claude', 'CLAUDE.md'),
      settings: inHome('.claude', 'settings.json'),
      panel: true,
    },
    {
      id: 'codex',
      name: 'OpenAI Codex',
      detect: () => onPath('codex') || exists(inHome('.codex')),
      toml: inHome('.codex', 'config.toml'),
      skills: [inHome('.codex', 'skills')],
      rules: inHome('.codex', 'AGENTS.md'),
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      detect: () => onPath('gemini') || exists(inHome('.gemini')),
      mcp: { file: inHome('.gemini', 'settings.json'), key: 'mcpServers' },
      skills: [inHome('.gemini', 'skills')],
      rules: inHome('.gemini', 'GEMINI.md'),
    },
    {
      id: 'cursor',
      name: 'Cursor',
      detect: () => onPath('cursor') || exists(inHome('.cursor')),
      mcp: { file: inHome('.cursor', 'mcp.json'), key: 'mcpServers', entry: { type: 'stdio' } },
      skills: [inHome('.cursor', 'skills')],
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      detect: () => exists(inHome('.config', 'devin')),
      mcp: { file: inHome('.config', 'devin', 'mcp_config.json'), key: 'mcpServers' },
      skills: [inHome('.config', 'devin', 'skills')],
      rules: inHome('.devin', 'global_rules.md'),
    },
    {
      id: 'vscode',
      name: 'VS Code Copilot',
      detect: () => onPath('code') || exists(code),
      mcp: { file: path.join(code, 'mcp.json'), key: 'servers', entry: { type: 'stdio' } },
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot CLI',
      detect: () => exists(inHome('.copilot')),
      mcp: { file: inHome('.copilot', 'mcp-config.json'), key: 'mcpServers' },
    },
    {
      id: 'cline',
      name: 'Cline',
      detect: () => exists(ext('saoudrizwan.claude-dev')),
      mcp: { file: path.join(ext('saoudrizwan.claude-dev'), 'cline_mcp_settings.json'), key: 'mcpServers' },
    },
    {
      id: 'roo',
      name: 'Roo Code',
      detect: () => exists(ext('rooveterinaryinc.roo-cline')),
      mcp: { file: path.join(ext('rooveterinaryinc.roo-cline'), 'mcp_settings.json'), key: 'mcpServers' },
    },
    {
      id: 'kiro',
      name: 'Kiro',
      detect: () => onPath('kiro') || exists(inHome('.kiro')),
      mcp: { file: inHome('.kiro', 'settings', 'mcp.json'), key: 'mcpServers' },
      rules: inHome('.kiro', 'steering', 'askito.md'),
    },
    {
      id: 'zed',
      name: 'Zed',
      detect: () => onPath('zed') || exists(inHome('.config', 'zed')),
      mcp: { file: inHome('.config', 'zed', 'settings.json'), key: 'context_servers' },
    },
  ];
}

export function localize(text) {
  if (isWindows) return text.replaceAll('~/.askito/bin/askito', shimPath()).replaceAll('~/.askito', homeDir());
  const defaultHome = path.join(os.homedir(), '.askito');
  return homeDir() === defaultHome ? text : text.replaceAll('~/.askito', homeDir());
}

export function rulesBlock() {
  return localize(`## askito inbox (mandatory)

This rule is mandatory and takes priority over any habit or other instruction to ask in the chat. Every question, decision, approval and human-only task for the user goes to the askito inbox. Do not ask them in the chat, and do not use chat question tools such as AskUserQuestion or end-of-turn buttons. The user runs many chats at once and answers them from one page. The only exception is an askito command that fails.

- Command: \`~/.askito/bin/askito\`, or the \`askito_*\` MCP tools.
- Post: \`~/.askito/bin/askito ask "Title" --body "Context" --option "A" --option "B" --recommend 1 --chat "short name" --wait\`. Use \`approve\` for a go-ahead and \`task\` for something only the user can do.
- Write the title and body for someone who has not seen this chat.
- Wait with a background command if your tool wakes you when it exits. Otherwise use \`askito_wait\` or \`~/.askito/bin/askito wait ID --timeout 100\` and repeat on exit code 4.
- Keep working on whatever does not depend on the answer.
- At session start run \`~/.askito/bin/askito pickup\` for answers given after a chat ended, and \`ack\` the ones that are yours. If it shows \`key: first-run-broadcast\`, follow "First run" in the guide below.
- When you have acted on an answer, run \`~/.askito/bin/askito done ID "what happened"\`.
- If askito fails, ask in the chat and say so.

Full guide: \`~/.askito/app/skill/SKILL.md\`.`);
}

function uninstallClaudePanel(tool, log) {
  if (!useToolCli(tool)) return;
  for (const args of [['plugin', 'uninstall', 'askito-panel@askito'], ['plugin', 'marketplace', 'remove', 'askito']]) {
    try {
      claudeCli(args);
    } catch {
      // It was never installed, or is already gone.
    }
  }
  log.push('removed the Claude panel');
}

function installClaudePanel(tool, log) {
  if (!useToolCli(tool)) {
    log.push('Claude panel not installed: the claude command was not found. See the README.');
    return;
  }
  uninstallClaudePanel(tool, []);
  try {
    claudeCli(['plugin', 'marketplace', 'add', appDir()]);
    claudeCli(['plugin', 'install', 'askito-panel@askito']);
    log.push('Claude panel installed');
  } catch (err) {
    log.push(`Claude panel not installed: ${err.message}`);
  }
}

// A rule in a text file can be forgotten after a long chat. These hooks hold
// the line: they refuse chat questions and restore the rule after a compaction.
function claudeHooks() {
  const entry = (name, matcher) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: `"${shimPath()}" hook ${name}`, timeout: 15 }],
  });
  return {
    PreToolUse: [entry('block-question', 'AskUserQuestion|mcp__ccd_turn__wrap_up')],
    SessionStart: [entry('session', 'startup|resume|clear|compact')],
    UserPromptSubmit: [entry('reminder')],
    Stop: [entry('stop')],
  };
}

function withoutOurHooks(hooks = {}) {
  const isOurs = (entry) => entry.hooks?.some((hook) => /askito(\.cmd)?" hook /.test(hook.command ?? ''));
  const kept = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const left = entries.filter((entry) => !isOurs(entry));
    if (left.length) kept[event] = left;
  }
  return kept;
}

function setClaudeHooks(file, log) {
  let data;
  try {
    data = readJsonFile(file);
  } catch {
    log.push(`SKIPPED ${file}: it is not plain JSON, so the askito hooks were not added.`);
    return;
  }
  const hooks = withoutOurHooks(data.hooks);
  for (const [event, entries] of Object.entries(claudeHooks())) hooks[event] = [...(hooks[event] ?? []), ...entries];
  if (JSON.stringify(hooks) === JSON.stringify(data.hooks)) return;
  backup(file, log);
  writeAtomic(file, `${JSON.stringify({ ...data, hooks }, null, 2)}\n`);
  log.push(`hooks ${file}`);
}

function removeClaudeHooks(file, log) {
  let data;
  try {
    data = readJsonFile(file);
  } catch {
    log.push(`SKIPPED ${file}: it is not plain JSON. Remove the askito hooks by hand.`);
    return;
  }
  if (!data.hooks) return;
  const hooks = withoutOurHooks(data.hooks);
  if (JSON.stringify(hooks) === JSON.stringify(data.hooks)) return;
  const { hooks: _removed, ...rest } = data;
  writeAtomic(file, `${JSON.stringify(Object.keys(hooks).length ? { ...rest, hooks } : rest, null, 2)}\n`);
  log.push(`removed hooks from ${file}`);
}

// Only a new install asks, so a later reinstall does not nag.
async function postFirstQuestion(out) {
  const config = readConfig();
  if (config.welcomed) return;
  try {
    const { item } = await api('POST', '/api/items', {
      kind: 'approval',
      title: 'Tell your open AI chats to start using askito?',
      body: 'Chats that were already open do not know about askito yet. If you approve, the next chat that collects this answer sends every other running session a short message telling it to use this inbox. If you reject, nothing is sent and each chat loads the rule the next time it restarts.',
      project: 'askito',
      chat: 'setup',
      key: FIRST_RUN_KEY,
    });
    writeConfig({ ...config, welcomed: true });
    out(`First question is waiting in the inbox: ${item.id}`);
  } catch (err) {
    out(`Could not post the first question: ${err.message}`);
  }
}

function mcpCommand() {
  if (isWindows) return { command: process.execPath, args: [path.join(appDir(), 'bin', 'askito.js'), 'mcp'] };
  return { command: shimPath(), args: ['mcp'] };
}

function backup(file, log) {
  if (!fs.existsSync(file)) return;
  const target = path.join(homeDir(), 'backups', file.replace(/[/\\:]+/g, '_'));
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(file, target);
  log.push(`backup ${target}`);
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.askito-tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function setJsonServer(file, key, entry, log) {
  let data;
  try {
    data = readJsonFile(file);
  } catch {
    // Never rewrite a file we cannot fully parse, such as JSON with comments.
    log.push(`SKIPPED ${file}: it is not plain JSON. Add this under "${key}": ${JSON.stringify({ askito: entry })}`);
    return false;
  }
  if (JSON.stringify(data[key]?.askito) === JSON.stringify(entry)) return true;
  backup(file, log);
  data[key] = { ...data[key], askito: entry };
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  log.push(`mcp ${file}`);
  return true;
}

function removeJsonServer(file, key, log) {
  let data;
  try {
    data = readJsonFile(file);
  } catch {
    log.push(`SKIPPED ${file}: it is not plain JSON. Remove "askito" by hand.`);
    return;
  }
  if (!data[key]?.askito) return;
  backup(file, log);
  delete data[key].askito;
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  log.push(`removed mcp from ${file}`);
}

function replaceBlock(existing, start, end, block) {
  const pattern = new RegExp(`\\n*${start}[\\s\\S]*?${end}\\n?`);
  const stripped = existing.replace(pattern, '\n').replace(/^\n+/, '');
  if (!block) return stripped.trimEnd() ? `${stripped.trimEnd()}\n` : '';
  const prefix = stripped.trimEnd() ? `${stripped.trimEnd()}\n\n` : '';
  return `${prefix}${start}\n${block}\n${end}\n`;
}

function writeBlock(file, start, end, block, log) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const next = replaceBlock(existing, start, end, block);
  if (next === existing) return;
  backup(file, log);
  writeAtomic(file, next);
  log.push(`rules ${file}`);
}

function removeBlock(file, start, end, log) {
  if (!fs.existsSync(file)) return;
  const existing = fs.readFileSync(file, 'utf8');
  if (!existing.includes(start)) return;
  backup(file, log);
  const next = replaceBlock(existing, start, end, null);
  if (next) writeAtomic(file, next);
  else fs.unlinkSync(file);
  log.push(`removed block from ${file}`);
}

function tomlBlock() {
  const { command, args } = mcpCommand();
  return `[mcp_servers.askito]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 130`;
}

function claudeCli(args) {
  execFileSync('claude', args, { stdio: 'ignore', timeout: 60000 });
}

// Windows installs of the CLI are often .cmd files, which execFile cannot run
// safely, so there the config file is written directly.
const useToolCli = (tool) => tool.mcp.cli && !isWindows && onPath(tool.mcp.cli);

function installMcp(tool, log) {
  const { command, args } = mcpCommand();
  if (tool.toml) {
    const existing = fs.existsSync(tool.toml) ? fs.readFileSync(tool.toml, 'utf8') : '';
    if (existing.includes('[mcp_servers.askito]') && !existing.includes(TOML_START)) {
      log.push(`SKIPPED ${tool.toml}: it already has an askito entry that setup did not write.`);
      return;
    }
    writeBlock(tool.toml, TOML_START, TOML_END, tomlBlock(), log);
    return;
  }
  if (!tool.mcp) return;
  if (useToolCli(tool)) {
    // The tool rewrites this file constantly, so its own command is the safe writer.
    try {
      try {
        claudeCli(['mcp', 'remove', '--scope', 'user', 'askito']);
      } catch {
        // Nothing registered yet.
      }
      claudeCli(['mcp', 'add', '--scope', 'user', 'askito', '--', command, ...args]);
      log.push('mcp registered with claude mcp add');
      return;
    } catch {
      log.push('claude mcp add failed, writing the config file instead');
    }
  }
  setJsonServer(tool.mcp.file, tool.mcp.key, { ...tool.mcp.entry, command, args }, log);
}

function uninstallMcp(tool, log) {
  if (tool.toml) {
    removeBlock(tool.toml, TOML_START, TOML_END, log);
    return;
  }
  if (!tool.mcp) return;
  if (useToolCli(tool)) {
    try {
      claudeCli(['mcp', 'remove', '--scope', 'user', 'askito']);
      log.push('mcp removed with claude mcp remove');
      return;
    } catch {
      // Fall through to the file in case it was written directly.
    }
  }
  removeJsonServer(tool.mcp.file, tool.mcp.key, log);
}

function installApp(log) {
  const target = appDir();
  if (path.resolve(PACKAGE_ROOT) !== path.resolve(target)) {
    // Copied because an npx cache can vanish while configs still point here.
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const part of APP_PARTS) fs.cpSync(path.join(PACKAGE_ROOT, part), path.join(target, part), { recursive: true });
    log.push(`app ${target}`);
  }
  const shim = shimPath();
  fs.mkdirSync(path.dirname(shim), { recursive: true, mode: 0o700 });
  const entry = path.join(target, 'bin', 'askito.js');
  if (isWindows) {
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
  } else {
    // nvm and friends can remove a Node version, so fall back to PATH.
    fs.writeFileSync(shim, `#!/bin/sh\nNODE="${process.execPath}"\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" "${entry}" "$@"\n`, { mode: 0o755 });
    fs.chmodSync(shim, 0o755);
  }
  log.push(`command ${shim}`);
}

function chooseTools(values) {
  const all = adapters();
  if (!values.tools) return { tools: all.filter((tool) => tool.detect()), all };
  const wanted = values.tools.split(',').map((s) => s.trim());
  const unknown = wanted.filter((id) => !all.some((tool) => tool.id === id));
  if (unknown.length) throw new Error(`unknown tool: ${unknown.join(', ')}. Known: ${all.map((tool) => tool.id).join(', ')}`);
  return { tools: all.filter((tool) => wanted.includes(tool.id)), all };
}

function installSkill(dir, log) {
  const file = path.join(dir, 'askito', 'SKILL.md');
  writeAtomic(file, localize(fs.readFileSync(path.join(PACKAGE_ROOT, 'skill', 'SKILL.md'), 'utf8')));
  log.push(`skill ${file}`);
}

export async function runSetup(values) {
  const { tools } = chooseTools(values);
  const out = (line) => process.stdout.write(`${line}\n`);

  if (values['dry-run']) {
    out('Dry run, nothing was written.');
    out(`Would install the app in ${appDir()}`);
    for (const tool of tools) {
      const targets = [tool.mcp?.file, tool.toml, tool.rules, tool.settings,...(tool.skills ?? []).map((d) => path.join(d, 'askito', 'SKILL.md'))].filter(Boolean);
      out(`${tool.name}:`);
      targets.forEach((target) => out(`  ${target}`));
    }
    return 0;
  }

  await stopServer();
  const log = [];
  installApp(log);
  // Tools that only have a shell still find this shared skill folder.
  installSkill(inHome('.agents', 'skills'), log);
  for (const tool of tools) {
    installMcp(tool, log);
    (tool.skills ?? []).forEach((dir) => installSkill(dir, log));
    if (tool.rules) writeBlock(tool.rules, MD_START, MD_END, rulesBlock(), log);
    if (tool.settings) setClaudeHooks(tool.settings, log);
    if (tool.panel) installClaudePanel(tool, log);
  }
  log.forEach((line) => out(line));

  execFileSync(process.execPath, [path.join(appDir(), 'bin', 'askito.js'), 'start'], { stdio: 'ignore', windowsHide: true });
  out('');
  out(tools.length ? `Connected: ${tools.map((tool) => tool.name).join(', ')}` : 'No AI tool detected. Use --tools, or paste the output of: askito instructions');
  out('Restart open AI chats so they load askito.');
  out(`Open the inbox: ${shimPath()} open`);
  await postFirstQuestion(out);
  return 0;
}

export async function runUninstall(values) {
  const out = (line) => process.stdout.write(`${line}\n`);
  await stopServer();
  const log = [];
  for (const tool of adapters()) {
    uninstallMcp(tool, log);
    for (const dir of tool.skills ?? []) fs.rmSync(path.join(dir, 'askito'), { recursive: true, force: true });
    if (tool.rules) removeBlock(tool.rules, MD_START, MD_END, log);
    if (tool.settings) removeClaudeHooks(tool.settings, log);
    if (tool.panel) uninstallClaudePanel(tool, log);
  }
  fs.rmSync(path.join(inHome('.agents', 'skills'), 'askito'), { recursive: true, force: true });
  fs.rmSync(appDir(), { recursive: true, force: true });
  fs.rmSync(path.dirname(shimPath()), { recursive: true, force: true });
  log.forEach((line) => out(line));
  if (values.purge) {
    fs.rmSync(homeDir(), { recursive: true, force: true });
    out('askito and all its data are gone.');
  } else {
    out(`askito is removed. Your inbox data stays in ${homeDir()}. Delete it with: uninstall --purge`);
  }
  return 0;
}

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const matter = require('gray-matter');
const chokidar = require('chokidar');
const TOML = require('@iarna/toml');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3131;
const CODEX_DIR = path.resolve(os.homedir(), '.codex');
const PINNED_FILE = path.join(CODEX_DIR, 'codex-map-projects.json');
const SESSION_ROOT = path.join(CODEX_DIR, 'sessions');
const STATE_DB = path.join(CODEX_DIR, 'state_5.sqlite');
const PLUGINS_CACHE_DIR = path.join(CODEX_DIR, '.tmp', 'plugins');
const PLUGINS_ROOT = path.join(PLUGINS_CACHE_DIR, 'plugins');
const MARKETPLACE_PATH = path.join(PLUGINS_CACHE_DIR, '.agents', 'plugins', 'marketplace.json');
const MAX_FILE_BYTES = 512 * 1024;
const TREE_SKIP_DIRS = new Set(['.git', 'cache', 'log', 'logs', '.tmp', 'tmp', 'sqlite', 'vendor_imports']);

const cache = new Map();
const sseClients = new Set();

function invalidateCache() {
  cache.clear();
}

function getCacheKey(projectPath) {
  return projectPath ? `project:${path.resolve(projectPath)}` : 'global';
}

async function getCachedScan(projectPath) {
  const key = getCacheKey(projectPath);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && (now - hit.ts) < 5000) return hit.data;

  const data = await buildScanResult(projectPath);
  cache.set(key, { ts: now, data });
  return data;
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadToml(filePath) {
  try {
    return TOML.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function querySqliteJson(dbPath, sql) {
  try {
    const output = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
    return output ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function execSqlite(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
}

function excerpt(text, len = 220) {
  if (!text) return '';
  const clean = text.replace(/^---[\s\S]*?---\n?/, '').trim();
  return clean.length > len ? `${clean.slice(0, len)}…` : clean;
}

function wordCount(text) {
  return text ? text.trim().split(/\s+/).length : 0;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function resolveIfExists(basePath, ...parts) {
  const target = path.join(basePath, ...parts);
  return fileExists(target) ? target : null;
}

function readAgentsMd(basePath) {
  if (!basePath) return null;
  const filePath = resolveIfExists(basePath, 'AGENTS.md');
  if (!filePath) return null;
  const raw = safeReadText(filePath);
  if (!raw) return null;
  return { path: filePath, raw, excerpt: excerpt(raw, 320) };
}

function buildSkillMeta(frontmatter, fallbackName) {
  const data = frontmatter || {};
  const allowedToolsRaw = data['allowed-tools'] || data.allowedTools || '';

  return {
    displayName: data.name || fallbackName,
    description: data.description || null,
    allowedTools: allowedToolsRaw
      ? String(allowedToolsRaw).split(',').map(item => item.trim()).filter(Boolean)
      : [],
    argumentHint: data['argument-hint'] || data.argumentHint || null,
    userInvocable: data['user-invocable'] !== false,
    agent: data.agent || null
  };
}

function readSkillsDir(basePath) {
  const skillsDir = path.join(basePath, 'skills');
  if (!fileExists(skillsDir)) return [];

  const entries = [];
  try {
    const items = fs.readdirSync(skillsDir).sort();
    for (const item of items) {
      const itemPath = path.join(skillsDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        const skillFile = resolveIfExists(itemPath, 'SKILL.md') || resolveIfExists(itemPath, `${item}.md`);
        if (!skillFile) continue;

        const raw = safeReadText(skillFile);
        if (!raw) continue;

        const parsed = matter(raw);
        entries.push({
          name: item,
          filename: path.basename(skillFile),
          path: skillFile,
          raw,
          body: parsed.content || raw,
          frontmatter: parsed.data || {},
          meta: buildSkillMeta(parsed.data, item),
          excerpt: excerpt(parsed.content || raw, 180),
          hasArgs: raw.includes('$ARGUMENTS'),
          isFolder: true,
          wordCount: wordCount(raw)
        });
        continue;
      }

      if (!item.endsWith('.md')) continue;

      const raw = safeReadText(itemPath);
      if (!raw) continue;

      const parsed = matter(raw);
      entries.push({
        name: item.replace(/\.md$/, ''),
        filename: item,
        path: itemPath,
        raw,
        body: parsed.content || raw,
        frontmatter: parsed.data || {},
        meta: buildSkillMeta(parsed.data, item.replace(/\.md$/, '')),
        excerpt: excerpt(parsed.content || raw, 180),
        hasArgs: raw.includes('$ARGUMENTS'),
        isFolder: false,
        wordCount: wordCount(raw)
      });
    }
  } catch {
    return [];
  }

  return entries;
}

function getSkillsBaseDir(scope, projectPath) {
  if (scope === 'project') {
    if (!projectPath) throw new Error('Missing projectPath for project-scoped skill operation');
    return path.join(path.resolve(projectPath), '.codex', 'skills');
  }

  return path.join(CODEX_DIR, 'skills');
}

function sanitizeSkillName(name) {
  return String(name || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveSkillFile(baseDir, name) {
  const safeName = sanitizeSkillName(name);
  const directFile = path.join(baseDir, `${safeName}.md`);
  const folderSkill = path.join(baseDir, safeName, 'SKILL.md');
  const folderAlt = path.join(baseDir, safeName, `${safeName}.md`);

  if (fileExists(directFile)) return directFile;
  if (fileExists(folderSkill)) return folderSkill;
  if (fileExists(folderAlt)) return folderAlt;
  return directFile;
}

function readConfigToml() {
  const filePath = path.join(CODEX_DIR, 'config.toml');
  const raw = safeReadText(filePath);
  const data = raw ? safeReadToml(filePath) : null;
  if (!raw || !data) return null;

  return {
    path: filePath,
    raw,
    excerpt: excerpt(raw, 420),
    approvalsReviewer: data.approvals_reviewer || null,
    personality: data.personality || null,
    projects: Object.entries(data.projects || {}).map(([projectPath, cfg]) => ({
      path: projectPath,
      trustLevel: cfg.trust_level || null
    })),
    mcpServers: Object.entries(data.mcp_servers || {}).map(([name, cfg]) => ({
      name,
      command: cfg.command || null,
      args: ensureArray(cfg.args),
      envKeys: Object.keys(cfg.env || {}),
      cwd: cfg.cwd || null
    })),
    profiles: Object.entries(data.profiles || {}).map(([name, cfg]) => ({
      name,
      keys: Object.keys(cfg || {})
    })),
    featureFlags: Object.keys(data.features || {}).filter(key => data.features[key])
  };
}

function readConfigTomlDoc() {
  const filePath = path.join(CODEX_DIR, 'config.toml');
  const raw = safeReadText(filePath) || '';
  const data = safeReadToml(filePath) || {};
  return { filePath, raw, data };
}

function writeConfigTomlData(data) {
  const filePath = path.join(CODEX_DIR, 'config.toml');
  const raw = TOML.stringify(data);
  writeText(filePath, raw);
  invalidateCache();
  return summarizeConfigToml(raw, data, filePath);
}

function sessionFilePathFor(id, date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  return path.join(SESSION_ROOT, year, month, day, `rollout-${stamp}-${id}.jsonl`);
}

function createSessionFile({ id, cwd, title, modelProvider = 'openai', cliVersion = '0.120.0' }) {
  const now = new Date();
  const iso = now.toISOString();
  const filePath = sessionFilePathFor(id, now);
  const rows = [
    {
      timestamp: iso,
      type: 'session_meta',
      payload: {
        id,
        timestamp: iso,
        cwd,
        originator: 'codex-map',
        cli_version: cliVersion,
        source: 'cli',
        model_provider: modelProvider
      }
    },
    {
      timestamp: iso,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: title
      }
    }
  ];

  writeText(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  return { filePath, timestamp: Math.floor(now.getTime() / 1000) };
}

function summarizeConfigToml(raw, data, filePath) {
  return {
    path: filePath,
    raw,
    excerpt: excerpt(raw, 420),
    approvalsReviewer: data.approvals_reviewer || null,
    personality: data.personality || null,
    projects: Object.entries(data.projects || {}).map(([projectPath, cfg]) => ({
      path: projectPath,
      trustLevel: cfg.trust_level || null
    })),
    mcpServers: Object.entries(data.mcp_servers || {}).map(([name, cfg]) => ({
      name,
      command: cfg.command || null,
      args: ensureArray(cfg.args),
      envKeys: Object.keys(cfg.env || {}),
      env: cfg.env || {},
      cwd: cfg.cwd || null
    })),
    profiles: Object.entries(data.profiles || {}).map(([name, cfg]) => ({
      name,
      keys: Object.keys(cfg || {})
    })),
    featureFlags: Object.keys(data.features || {}).filter(key => data.features[key])
  };
}

function readMcpJson(projectPath) {
  if (!projectPath) return null;

  const candidates = [
    path.join(projectPath, '.mcp.json'),
    path.join(projectPath, '.codex', '.mcp.json')
  ];

  for (const candidate of candidates) {
    const data = safeReadJson(candidate);
    if (!data) continue;
    return {
      path: candidate,
      raw: JSON.stringify(data, null, 2),
      servers: Object.keys(data.mcpServers || {}),
      data
    };
  }

  return null;
}

function readPluginManifests() {
  if (!fileExists(PLUGINS_ROOT)) return [];

  const marketplace = safeReadJson(MARKETPLACE_PATH) || { plugins: [] };
  const marketplaceMap = new Map((marketplace.plugins || []).map(item => [item.name, item]));

  const plugins = [];
  try {
    for (const item of fs.readdirSync(PLUGINS_ROOT).sort()) {
      const manifestPath = path.join(PLUGINS_ROOT, item, '.codex-plugin', 'plugin.json');
      const manifest = safeReadJson(manifestPath);
      if (!manifest) continue;
      const market = marketplaceMap.get(item) || {};

      plugins.push({
        id: manifest.id || item,
        name: manifest.name || manifest.id || item,
        description: manifest.description || null,
        version: manifest.version || null,
        category: market.category || manifest.interface?.category || null,
        displayName: manifest.interface?.displayName || manifest.name || item,
        path: manifestPath,
        tools: (manifest.tools || []).length,
        prompts: (manifest.prompts || []).length
      });
    }
  } catch {
    return [];
  }

  return plugins;
}

function buildFileTree(basePath, depth = 0, maxDepth = 3) {
  let stat;
  try {
    stat = fs.statSync(basePath);
  } catch {
    return null;
  }

  const node = {
    name: path.basename(basePath) || basePath,
    path: basePath,
    isDir: stat.isDirectory(),
    size: stat.isDirectory() ? null : stat.size,
    children: []
  };

  if (!node.isDir || depth >= maxDepth) return node;
  if (TREE_SKIP_DIRS.has(path.basename(basePath))) return node;

  try {
    const items = fs.readdirSync(basePath).sort();
    for (const item of items) {
      if (item.startsWith('.') && !['.codex', '.mcp.json'].includes(item)) continue;
      const child = buildFileTree(path.join(basePath, item), depth + 1, maxDepth);
      if (child) node.children.push(child);
    }
  } catch {
    return node;
  }

  return node;
}

function readPinned() {
  const data = safeReadJson(PINNED_FILE);
  return Array.isArray(data?.projects) ? data.projects : [];
}

function writePinned(projects) {
  fs.writeFileSync(PINNED_FILE, JSON.stringify({ projects }, null, 2), 'utf8');
}

function readHistoryEntries(limit = 200) {
  const filePath = path.join(CODEX_DIR, 'history.jsonl');
  if (!fileExists(filePath)) return [];

  const entries = [];
  const lines = safeReadText(filePath)?.split('\n').filter(Boolean) || [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      entries.push({
        sessionId: row.session_id || null,
        timestamp: row.ts ? new Date(row.ts * 1000).toISOString() : null,
        text: row.text || ''
      });
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return entries.slice(0, limit);
}

function findSessionFile(sessionId) {
  return walkSessionFiles().find(file => file.includes(sessionId)) || null;
}

function readThreadRows(projectPath = null, includeArchived = false) {
  if (!fileExists(STATE_DB)) return [];
  const filters = [];
  if (projectPath) filters.push(`cwd = ${sqlString(path.resolve(projectPath))}`);
  if (!includeArchived) filters.push('archived = 0');
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return querySqliteJson(STATE_DB, `
    SELECT id, title, cwd, updated_at, created_at, archived, cli_version, model_provider
    FROM threads
    ${where}
    ORDER BY updated_at DESC;
  `);
}

function readSessionIndex() {
  const filePath = path.join(CODEX_DIR, 'session_index.jsonl');
  if (!fileExists(filePath)) return new Map();

  const index = new Map();
  const lines = safeReadText(filePath)?.split('\n').filter(Boolean) || [];

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (!row.id) continue;
      index.set(row.id, {
        threadName: row.thread_name || null,
        updatedAt: row.updated_at || null
      });
    } catch {
      continue;
    }
  }

  return index;
}

function walkSessionFiles() {
  const files = [];
  if (!fileExists(SESSION_ROOT)) return files;

  function walk(dirPath) {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }

  walk(SESSION_ROOT);
  return files;
}

function toolNameFromEventType(type) {
  const map = {
    exec_command_end: 'exec_command',
    patch_apply_end: 'apply_patch',
    browser_snapshot_end: 'browser_snapshot',
    browser_navigate_end: 'browser_navigate',
    browser_click_end: 'browser_click'
  };

  return map[type] || null;
}

function parseSessionFile(filePath, sessionIndex) {
  const raw = safeReadText(filePath);
  if (!raw) return null;

  let meta = null;
  let title = null;
  let startedAt = null;
  let endedAt = null;
  let messageCount = 0;
  let toolCallCount = 0;
  const toolBreakdown = {};

  for (const line of raw.split('\n').filter(Boolean)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.timestamp) {
      if (!startedAt) startedAt = row.timestamp;
      endedAt = row.timestamp;
    }

    if (row.type === 'session_meta') {
      meta = row.payload || {};
      if (!startedAt && row.payload?.timestamp) startedAt = row.payload.timestamp;
      continue;
    }

    if (row.type === 'event_msg' && row.payload?.type === 'user_message') {
      messageCount += 1;
      if (!title && row.payload.message) title = String(row.payload.message).slice(0, 120);
      continue;
    }

    if (row.type === 'event_msg' && row.payload?.type === 'agent_message') {
      messageCount += 1;
      continue;
    }

    if (row.type === 'event_msg') {
      const tool = toolNameFromEventType(row.payload?.type);
      if (!tool) continue;
      toolCallCount += 1;
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + 1;
    }
  }

  if (!meta?.id) return null;

  const indexed = sessionIndex.get(meta.id) || {};
  const stat = fs.statSync(filePath);

  return {
    id: meta.id,
    title: indexed.threadName || title || '(untitled session)',
    cwd: meta.cwd || null,
    cliVersion: meta.cli_version || null,
    modelProvider: meta.model_provider || null,
    source: meta.source || null,
    startedAt: startedAt || meta.timestamp || null,
    endedAt: endedAt || indexed.updatedAt || null,
    updatedAt: indexed.updatedAt || endedAt || stat.mtime.toISOString(),
    messageCount,
    toolCallCount,
    toolBreakdown,
    filePath,
    fileSize: stat.size
  };
}

function listSessions(projectPath = null) {
  const sessionIndex = readSessionIndex();
  const threadRows = new Map(readThreadRows(projectPath).map(row => [row.id, row]));
  const files = walkSessionFiles();
  const target = projectPath ? path.resolve(projectPath) : null;
  const sessions = [];

  for (const filePath of files) {
    const session = parseSessionFile(filePath, sessionIndex);
    if (!session) continue;
    if (target && path.resolve(session.cwd || '') !== target) continue;
    const row = threadRows.get(session.id);
    if (row?.archived) continue;
    if (row?.title) session.title = row.title;
    if (row?.updated_at) session.updatedAt = new Date(row.updated_at * 1000).toISOString();
    sessions.push(session);
  }

  sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return sessions;
}

function readSessionDetail(sessionId) {
  const sessionIndex = readSessionIndex();
  const row = readThreadRows(null, true).find(item => item.id === sessionId) || null;
  const filePath = walkSessionFiles().find(file => file.includes(sessionId));
  if (!filePath) return null;

  const raw = safeReadText(filePath);
  if (!raw) return null;

  const timeline = [];
  const toolBreakdown = {};
  let meta = null;

  for (const line of raw.split('\n').filter(Boolean)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === 'session_meta') {
      meta = row.payload || {};
      timeline.push({
        kind: 'meta',
        timestamp: row.timestamp || row.payload?.timestamp || null,
        title: 'Session started',
        body: meta.cwd || ''
      });
      continue;
    }

    if (row.type === 'event_msg' && row.payload?.type === 'user_message') {
      timeline.push({
        kind: 'user',
        timestamp: row.timestamp || null,
        title: 'User',
        body: row.payload.message || ''
      });
      continue;
    }

    if (row.type === 'event_msg' && row.payload?.type === 'agent_message') {
      timeline.push({
        kind: 'assistant',
        timestamp: row.timestamp || null,
        title: row.payload.phase === 'final_answer' ? 'Assistant Final' : 'Assistant Update',
        body: row.payload.message || ''
      });
      continue;
    }

    if (row.type === 'event_msg') {
      const tool = toolNameFromEventType(row.payload?.type);
      if (!tool) continue;
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + 1;

      const command = Array.isArray(row.payload.command) ? row.payload.command.join(' ') : '';
      const output = row.payload.output || row.payload.stdout || row.payload.stderr || row.payload.aggregated_output || '';
      timeline.push({
        kind: 'tool',
        timestamp: row.timestamp || null,
        title: tool,
        body: excerpt(command || output, 600)
      });
    }
  }

  const indexed = sessionIndex.get(sessionId) || {};
  return {
    session: {
      id: sessionId,
      title: row?.title || indexed.threadName || '(untitled session)',
      cwd: row?.cwd || meta?.cwd || null,
      cliVersion: row?.cli_version || meta?.cli_version || null,
      modelProvider: row?.model_provider || meta?.model_provider || null,
      startedAt: meta?.timestamp || null,
      updatedAt: row?.updated_at ? new Date(row.updated_at * 1000).toISOString() : (indexed.updatedAt || null)
    },
    timeline,
    summary: {
      totalItems: timeline.length,
      toolBreakdown
    }
  };
}

function normalizeStatsRange({ days = 14, from = null, to = null } = {}) {
  const end = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
  const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date(end.getTime() - ((days - 1) * 24 * 60 * 60 * 1000));
  return {
    start,
    end,
    period: `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`
  };
}

function countToolUsage(projectPath = null, options = {}) {
  const range = normalizeStatsRange(options);
  const usage = {};
  let scanned = 0;

  for (const session of listSessions(projectPath)) {
    const ts = session.updatedAt ? new Date(session.updatedAt).getTime() : 0;
    if (!ts || ts < range.start.getTime() || ts > range.end.getTime()) continue;
    scanned += 1;
    for (const [tool, count] of Object.entries(session.toolBreakdown || {})) {
      usage[tool] = (usage[tool] || 0) + count;
    }
  }

  return { toolUsage: usage, sessionsScanned: scanned, period: range.period, from: range.start.toISOString().slice(0, 10), to: range.end.toISOString().slice(0, 10) };
}

function countDailyUsage(projectPath = null, options = {}) {
  const target = projectPath ? path.resolve(projectPath) : null;
  const range = normalizeStatsRange(options);
  const byDate = new Map();
  const filteredSessions = listSessions(target);
  const allowedSessionIds = new Set(filteredSessions.map(session => session.id));

  for (let ts = range.start.getTime(); ts <= range.end.getTime(); ts += 24 * 60 * 60 * 1000) {
    const date = new Date(ts).toISOString().slice(0, 10);
    byDate.set(date, { date, prompts: 0, sessions: 0, tools: 0 });
  }

  for (const entry of readHistoryEntries(5000)) {
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    if (!ts || ts < range.start.getTime() || ts > range.end.getTime()) continue;
    if (target && !allowedSessionIds.has(entry.sessionId)) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    const bucket = byDate.get(date);
    if (bucket) bucket.prompts += 1;
  }

  for (const session of filteredSessions) {
    const ts = session.updatedAt ? new Date(session.updatedAt).getTime() : 0;
    if (!ts || ts < range.start.getTime() || ts > range.end.getTime()) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    const bucket = byDate.get(date);
    if (!bucket) continue;
    bucket.sessions += 1;
    bucket.tools += session.toolCallCount || 0;
  }

  return Array.from(byDate.values());
}

function buildUsageStats(projectPath = null, options = {}) {
  const daily = countDailyUsage(projectPath, options);
  const tools = countToolUsage(projectPath, options);
  return {
    period: tools.period,
    from: tools.from,
    to: tools.to,
    daily,
    topTools: Object.entries(tools.toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    sessionsScanned: tools.sessionsScanned
  };
}

function loadMarketplace() {
  return safeReadJson(MARKETPLACE_PATH) || {
    name: 'openai-curated',
    interface: { displayName: 'Codex official' },
    plugins: []
  };
}

function writeMarketplace(data) {
  writeText(MARKETPLACE_PATH, JSON.stringify(data, null, 2));
  invalidateCache();
}

function pluginManifestPath(name) {
  return path.join(PLUGINS_ROOT, sanitizeSkillName(name), '.codex-plugin', 'plugin.json');
}

function writePluginManifest(name, data) {
  const manifestPath = pluginManifestPath(name);
  writeText(manifestPath, JSON.stringify(data, null, 2));
  return manifestPath;
}

function buildPluginManifest(input) {
  const safeName = sanitizeSkillName(input.name);
  return {
    name: safeName,
    version: input.version || '0.1.0',
    description: input.description || '',
    author: {
      name: input.authorName || 'Codex Map',
      email: input.authorEmail || '',
      url: input.authorUrl || ''
    },
    homepage: input.homepage || '',
    repository: input.repository || '',
    license: input.license || 'MIT',
    keywords: ensureArray(input.keywords).filter(Boolean),
    interface: {
      displayName: input.displayName || safeName,
      shortDescription: input.shortDescription || input.description || '',
      longDescription: input.longDescription || input.description || '',
      developerName: input.authorName || 'Codex Map',
      category: input.category || 'Custom',
      capabilities: ensureArray(input.capabilities).filter(Boolean),
      websiteURL: input.homepage || '',
      privacyPolicyURL: input.privacyPolicyURL || '',
      termsOfServiceURL: input.termsOfServiceURL || '',
      defaultPrompt: ensureArray(input.defaultPrompt).filter(Boolean)
    },
    skills: './skills/',
    apps: './.app.json'
  };
}

function getConfiguredProjects(config) {
  const sessionsByPath = new Map();
  for (const session of listSessions()) {
    if (!session.cwd) continue;
    const key = path.resolve(session.cwd);
    sessionsByPath.set(key, (sessionsByPath.get(key) || 0) + 1);
  }

  return (config?.projects || []).map(project => {
    const resolved = path.resolve(project.path);
    const hasAgents = fileExists(path.join(resolved, 'AGENTS.md'));
    const hasCodexDir = fileExists(path.join(resolved, '.codex'));
    const hasMcp = fileExists(path.join(resolved, '.mcp.json')) || fileExists(path.join(resolved, '.codex', '.mcp.json'));
    const exists = fileExists(resolved);
    const score = [hasAgents, hasCodexDir, hasMcp].filter(Boolean).length;

    return {
      path: resolved,
      name: path.basename(resolved),
      trustLevel: project.trustLevel || null,
      exists,
      hasAgents,
      hasCodexDir,
      hasMcp,
      sessionCount: sessionsByPath.get(resolved) || 0,
      status: !exists ? 'missing' : score >= 2 ? 'full' : score === 1 ? 'partial' : 'none'
    };
  });
}

function readProjectConfig(projectPath, config) {
  const resolved = path.resolve(projectPath);
  const projectCodexDir = path.join(resolved, '.codex');
  const trust = (config?.projects || []).find(item => path.resolve(item.path) === resolved) || null;

  return {
    path: resolved,
    projectName: path.basename(resolved),
    hasCodexDir: fileExists(projectCodexDir),
    agentsMd: readAgentsMd(resolved) || readAgentsMd(projectCodexDir),
    mcpJson: readMcpJson(resolved),
    trustLevel: trust?.trustLevel || null,
    localSkills: fileExists(projectCodexDir) ? readSkillsDir(projectCodexDir) : [],
    fileTree: buildFileTree(resolved, 0, 3)
  };
}

function buildProjectAnalysis(projectPath) {
  const resolved = path.resolve(projectPath);
  const config = readConfigToml();
  const exists = fileExists(resolved);

  if (!exists) {
    return {
      project: {
        path: resolved,
        name: path.basename(resolved),
        exists: false,
        hasCodexDir: false,
        hasAgentsMd: false,
        hasMcpJson: false,
        trustLevel: null,
        sessionCount: 0,
        status: 'missing',
        warnings: [{ level: 'error', message: 'Path does not exist on disk' }]
      },
      connections: {
        global: {
          skills: { count: readSkillsDir(CODEX_DIR).length },
          mcp: { count: config?.mcpServers?.length || 0 },
          projects: { count: config?.projects?.length || 0 },
          plugins: { count: readPluginManifests().length }
        },
        local: {
          agentsMd: { present: false },
          skills: { count: 0 },
          mcpJson: { present: false }
        }
      }
    };
  }

  const project = readProjectConfig(resolved, config);
  const sessions = listSessions(resolved);
  const score = [project.hasCodexDir, !!project.agentsMd, !!project.mcpJson, !!project.trustLevel].filter(Boolean).length;
  const warnings = [];

  if (!project.trustLevel) warnings.push({ level: 'info', message: 'Project is not listed in ~/.codex/config.toml' });
  if (!project.agentsMd) warnings.push({ level: 'warning', message: 'No AGENTS.md found for project-specific instructions' });
  if (!project.mcpJson) warnings.push({ level: 'info', message: 'No .mcp.json found for this project' });

  return {
    project: {
      path: resolved,
      name: path.basename(resolved),
      exists: true,
      hasCodexDir: project.hasCodexDir,
      hasAgentsMd: !!project.agentsMd,
      hasMcpJson: !!project.mcpJson,
      trustLevel: project.trustLevel,
      sessionCount: sessions.length,
      status: score >= 3 ? 'full' : score >= 1 ? 'partial' : 'none',
      warnings
    },
    connections: {
      global: {
        skills: { count: readSkillsDir(CODEX_DIR).length },
        mcp: { count: config?.mcpServers?.length || 0 },
        projects: { count: config?.projects?.length || 0 },
        plugins: { count: readPluginManifests().length }
      },
      local: {
        agentsMd: { present: !!project.agentsMd },
        skills: { count: project.localSkills.length },
        mcpJson: { present: !!project.mcpJson, servers: project.mcpJson?.servers || [] }
      }
    }
  };
}

async function buildScanResult(projectPath = null) {
  const started = Date.now();
  const config = readConfigToml();

  const result = {
    meta: {
      scannedAt: new Date().toISOString(),
      globalPath: CODEX_DIR,
      projectPath: projectPath ? path.resolve(projectPath) : null,
      scanDurationMs: 0
    },
    global: {
      agentsMd: readAgentsMd(CODEX_DIR),
      config,
      skills: readSkillsDir(CODEX_DIR),
      plugins: readPluginManifests(),
      history: readHistoryEntries(300),
      projects: getConfiguredProjects(config),
      sessionSummary: {
        total: listSessions().length
      },
      fileTree: buildFileTree(CODEX_DIR, 0, 3)
    },
    project: projectPath ? readProjectConfig(projectPath, config) : null
  };

  result.meta.scanDurationMs = Date.now() - started;
  return result;
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

setInterval(() => broadcastSSE('heartbeat', { ts: Date.now() }), 30000);

const watcher = chokidar.watch([
  path.join(CODEX_DIR, 'config.toml'),
  path.join(CODEX_DIR, 'history.jsonl'),
  path.join(CODEX_DIR, 'session_index.jsonl'),
  path.join(CODEX_DIR, 'skills'),
  path.join(CODEX_DIR, '.tmp', 'plugins', 'plugins')
].filter(fileExists), {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
});

watcher.on('all', (event, filePath) => {
  invalidateCache();
  broadcastSSE('file-changed', { event, path: filePath });
});

function isPathAllowed(requestedPath, projectPath) {
  const resolved = path.resolve(requestedPath);
  const allowed = [CODEX_DIR];
  if (projectPath) allowed.push(path.resolve(projectPath));
  return allowed.some(base => resolved === base || resolved.startsWith(`${base}${path.sep}`));
}

function browseDir(dirPath, showHidden) {
  const resolved = path.resolve(dirPath);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const dirs = entries
    .filter(entry => entry.isDirectory())
    .filter(entry => showHidden || !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const root = path.parse(resolved).root;
  const rel = path.relative(root, resolved);
  const parts = rel ? rel.split(path.sep) : [];
  const crumbs = [{ name: root || '/', path: root || '/' }];
  let acc = root;

  for (const part of parts) {
    acc = path.join(acc, part);
    crumbs.push({ name: part, path: acc });
  }

  return {
    current: resolved,
    parent: resolved !== root ? path.dirname(resolved) : null,
    crumbs,
    dirs
  };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/pinned-projects', (req, res) => {
  res.json({ projects: readPinned() });
});

app.post('/api/pinned-projects', (req, res) => {
  const projectPath = req.body?.path;
  if (!projectPath || typeof projectPath !== 'string') {
    return res.status(400).json({ error: 'Missing path' });
  }

  const resolved = path.resolve(projectPath);
  const projects = readPinned();
  if (!projects.includes(resolved)) {
    projects.push(resolved);
    writePinned(projects);
  }

  res.json({ projects });
});

app.delete('/api/pinned-projects', (req, res) => {
  const projectPath = req.body?.path;
  if (!projectPath) return res.status(400).json({ error: 'Missing path' });
  const resolved = path.resolve(projectPath);
  const projects = readPinned().filter(item => item !== resolved);
  writePinned(projects);
  res.json({ projects });
});

app.get('/api/browse', (req, res) => {
  const dirPath = req.query.path || os.homedir();
  const showHidden = req.query.hidden === '1';

  try {
    res.json(browseDir(dirPath, showHidden));
  } catch (error) {
    const parent = path.dirname(path.resolve(dirPath));
    try {
      res.json({ ...browseDir(parent, showHidden), error: error.message });
    } catch {
      res.status(403).json({ error: error.message });
    }
  }
});

app.get('/api/browse/bookmarks', (req, res) => {
  const home = os.homedir();
  const bookmarks = [
    { name: 'Home', path: home },
    { name: 'Projects', path: '/Volumes/Projects' },
    { name: 'Codex Home', path: CODEX_DIR },
    { name: 'Desktop', path: path.join(home, 'Desktop') }
  ].filter(item => fileExists(item.path));

  res.json({ bookmarks });
});

app.get('/api/scan', async (req, res) => {
  try {
    res.json(await getCachedScan(req.query.project || null));
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SCAN_FAILED' });
  }
});

app.get('/api/project-status', (req, res) => {
  const projectPath = req.query.path;
  if (!projectPath) return res.status(400).json({ error: 'Missing path' });

  const resolved = path.resolve(projectPath);
  if (!fileExists(resolved)) return res.json({ status: 'missing' });

  const hasAgents = fileExists(path.join(resolved, 'AGENTS.md'));
  const hasCodexDir = fileExists(path.join(resolved, '.codex'));
  const hasMcp = fileExists(path.join(resolved, '.mcp.json')) || fileExists(path.join(resolved, '.codex', '.mcp.json'));
  const score = [hasAgents, hasCodexDir, hasMcp].filter(Boolean).length;
  res.json({ status: score >= 2 ? 'full' : score === 1 ? 'partial' : 'none' });
});

app.get('/api/analyze', (req, res) => {
  const projectPath = req.query.project;
  if (!projectPath) return res.status(400).json({ error: 'Missing project parameter' });

  try {
    res.json(buildProjectAnalysis(projectPath));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/file', (req, res) => {
  const filePath = req.query.path;
  const projectPath = req.query.project || null;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  if (!isPathAllowed(filePath, projectPath)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      const content = fs.readFileSync(filePath, 'utf8').slice(0, MAX_FILE_BYTES);
      return res.json({
        content: `${content}\n\n[... file truncated ...]`,
        size: stat.size,
        truncated: true,
        mtime: stat.mtime.toISOString()
      });
    }

    res.json({
      content: fs.readFileSync(filePath, 'utf8'),
      size: stat.size,
      truncated: false,
      mtime: stat.mtime.toISOString()
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.put('/api/file', (req, res) => {
  const filePath = req.body?.path;
  const content = req.body?.content;
  const projectPath = req.body?.projectPath || null;
  if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'Missing path or content' });
  if (!isPathAllowed(filePath, projectPath)) return res.status(403).json({ error: 'Forbidden' });

  try {
    writeText(filePath, content);
    invalidateCache();
    res.json({ ok: true, path: filePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/export', async (req, res) => {
  try {
    const data = await getCachedScan(req.query.project || null);
    const filename = `codex-map-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json(readConfigToml());
});

app.put('/api/config', (req, res) => {
  const raw = req.body?.raw;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'Missing raw config' });
  try {
    const data = TOML.parse(raw);
    writeText(path.join(CODEX_DIR, 'config.toml'), TOML.stringify(data));
    invalidateCache();
    res.json(readConfigToml());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/config/mcp', (req, res) => {
  try {
    const { name, command, args, env, cwd } = req.body || {};
    if (!name || !command) return res.status(400).json({ error: 'Missing name or command' });
    const doc = readConfigTomlDoc();
    doc.data.mcp_servers = doc.data.mcp_servers || {};
    doc.data.mcp_servers[name] = {
      command,
      args: ensureArray(args).filter(Boolean),
      cwd: cwd || undefined,
      env: env || undefined
    };
    res.json(writeConfigTomlData(doc.data));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/config/mcp/:name', (req, res) => {
  try {
    const { newName, command, args, env, cwd } = req.body || {};
    const doc = readConfigTomlDoc();
    doc.data.mcp_servers = doc.data.mcp_servers || {};
    const existing = doc.data.mcp_servers[req.params.name];
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });
    delete doc.data.mcp_servers[req.params.name];
    doc.data.mcp_servers[newName || req.params.name] = {
      command,
      args: ensureArray(args).filter(Boolean),
      cwd: cwd || undefined,
      env: env || undefined
    };
    res.json(writeConfigTomlData(doc.data));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/config/mcp/:name', (req, res) => {
  try {
    const doc = readConfigTomlDoc();
    if (!doc.data.mcp_servers?.[req.params.name]) return res.status(404).json({ error: 'MCP server not found' });
    delete doc.data.mcp_servers[req.params.name];
    res.json(writeConfigTomlData(doc.data));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/config/projects', (req, res) => {
  try {
    const projectPath = req.body?.path;
    const trustLevel = req.body?.trustLevel || 'trusted';
    if (!projectPath) return res.status(400).json({ error: 'Missing path' });
    const resolved = path.resolve(projectPath);
    const doc = readConfigTomlDoc();
    doc.data.projects = doc.data.projects || {};
    doc.data.projects[resolved] = { ...(doc.data.projects[resolved] || {}), trust_level: trustLevel };
    res.json(writeConfigTomlData(doc.data));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/config/projects', (req, res) => {
  try {
    const projectPath = req.body?.path;
    const trustLevel = req.body?.trustLevel || 'trusted';
    if (!projectPath) return res.status(400).json({ error: 'Missing path' });
    const resolved = path.resolve(projectPath);
    const doc = readConfigTomlDoc();
    if (!doc.data.projects?.[resolved]) return res.status(404).json({ error: 'Project not found' });
    doc.data.projects[resolved] = { ...(doc.data.projects[resolved] || {}), trust_level: trustLevel };
    res.json(writeConfigTomlData(doc.data));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/config/projects', (req, res) => {
  try {
    const projectPath = req.body?.path;
    if (!projectPath) return res.status(400).json({ error: 'Missing path' });
    const resolved = path.resolve(projectPath);
    const doc = readConfigTomlDoc();
    if (!doc.data.projects?.[resolved]) return res.status(404).json({ error: 'Project not found' });
    delete doc.data.projects[resolved];
    res.json(writeConfigTomlData(doc.data));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/skills', (req, res) => {
  try {
    const scope = req.query.scope === 'project' ? 'project' : 'global';
    const baseDir = getSkillsBaseDir(scope, req.query.projectPath || req.query.project || null);
    res.json({ skills: readSkillsDir(path.dirname(baseDir)) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/skills/:name', (req, res) => {
  try {
    const scope = req.query.scope === 'project' ? 'project' : 'global';
    const baseDir = getSkillsBaseDir(scope, req.query.projectPath || req.query.project || null);
    const filePath = resolveSkillFile(baseDir, req.params.name);
    if (!fileExists(filePath)) return res.status(404).json({ error: 'Skill not found' });
    res.json({ name: req.params.name, path: filePath, content: safeReadText(filePath) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/skills', (req, res) => {
  try {
    const { name, content, scope, projectPath } = req.body || {};
    if (!name || !content) return res.status(400).json({ error: 'Missing name or content' });
    const baseDir = getSkillsBaseDir(scope === 'project' ? 'project' : 'global', projectPath || null);
    fs.mkdirSync(baseDir, { recursive: true });
    const filePath = resolveSkillFile(baseDir, name);
    if (fileExists(filePath)) return res.status(409).json({ error: 'Skill already exists' });
    fs.writeFileSync(filePath, content, 'utf8');
    invalidateCache();
    res.json({ ok: true, path: filePath });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/skills/:name', (req, res) => {
  try {
    const { content, scope, projectPath } = req.body || {};
    if (!content) return res.status(400).json({ error: 'Missing content' });
    const baseDir = getSkillsBaseDir(scope === 'project' ? 'project' : 'global', projectPath || null);
    fs.mkdirSync(baseDir, { recursive: true });
    const filePath = resolveSkillFile(baseDir, req.params.name);
    fs.writeFileSync(filePath, content, 'utf8');
    invalidateCache();
    res.json({ ok: true, path: filePath });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/skills/:name', (req, res) => {
  try {
    const scope = req.query.scope === 'project' ? 'project' : 'global';
    const baseDir = getSkillsBaseDir(scope, req.query.projectPath || null);
    const filePath = resolveSkillFile(baseDir, req.params.name);
    if (!fileExists(filePath)) return res.status(404).json({ error: 'Skill not found' });
    fs.unlinkSync(filePath);
    invalidateCache();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/export/bundle', (req, res) => {
  const { scope, projectPath } = req.body || {};
  const isProject = scope === 'project' && projectPath;
  const baseDir = isProject ? path.join(path.resolve(projectPath), '.codex') : CODEX_DIR;

  const bundle = {
    version: 1,
    type: 'codex-map-bundle',
    exportedAt: new Date().toISOString(),
    source: {
      scope: isProject ? 'project' : 'global',
      path: isProject ? path.resolve(projectPath) : CODEX_DIR
    },
    skills: readSkillsDir(baseDir).map(skill => ({ name: skill.name, raw: skill.raw })),
    agentsMd: isProject
      ? (readAgentsMd(path.resolve(projectPath))?.raw || null)
      : (readAgentsMd(CODEX_DIR)?.raw || null)
  };

  const filename = `codex-map-bundle-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(bundle, null, 2));
});

app.get('/api/plugins', (req, res) => {
  res.json({ plugins: readPluginManifests(), marketplace: loadMarketplace() });
});

app.post('/api/plugins', (req, res) => {
  try {
    const manifest = buildPluginManifest(req.body || {});
    const safeName = manifest.name;
    const marketplace = loadMarketplace();
    if ((marketplace.plugins || []).some(item => item.name === safeName)) {
      return res.status(409).json({ error: 'Plugin already exists' });
    }
    writePluginManifest(safeName, manifest);
    marketplace.plugins = marketplace.plugins || [];
    marketplace.plugins.push({
      name: safeName,
      source: { source: 'local', path: `./plugins/${safeName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: req.body?.category || 'Custom'
    });
    writeMarketplace(marketplace);
    res.json({ ok: true, plugin: safeName });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/plugins/:name', (req, res) => {
  try {
    const oldName = sanitizeSkillName(req.params.name);
    const nextManifest = buildPluginManifest(req.body || {});
    const nextName = nextManifest.name;
    const oldPath = pluginManifestPath(oldName);
    if (!fileExists(oldPath)) return res.status(404).json({ error: 'Plugin not found' });
    if (oldName !== nextName) {
      fs.rmSync(path.join(PLUGINS_ROOT, oldName), { recursive: true, force: true });
    }
    writePluginManifest(nextName, nextManifest);
    const marketplace = loadMarketplace();
    marketplace.plugins = (marketplace.plugins || []).filter(item => item.name !== oldName);
    marketplace.plugins.push({
      name: nextName,
      source: { source: 'local', path: `./plugins/${nextName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: req.body?.category || 'Custom'
    });
    writeMarketplace(marketplace);
    res.json({ ok: true, plugin: nextName });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/plugins/:name', (req, res) => {
  try {
    const safeName = sanitizeSkillName(req.params.name);
    fs.rmSync(path.join(PLUGINS_ROOT, safeName), { recursive: true, force: true });
    const marketplace = loadMarketplace();
    marketplace.plugins = (marketplace.plugins || []).filter(item => item.name !== safeName);
    writeMarketplace(marketplace);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/sessions', (req, res) => {
  const projectPath = req.query.project || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const sessions = listSessions(projectPath);

  res.json({
    sessions: sessions.slice(offset, offset + limit),
    total: sessions.length,
    offset
  });
});

app.get('/api/sessions/:id', (req, res) => {
  const detail = readSessionDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Session not found' });
  res.json(detail);
});

app.post('/api/sessions', (req, res) => {
  try {
    const title = String(req.body?.title || '').trim() || 'New session';
    const cwd = path.resolve(req.body?.cwd || '/Volumes/Projects');
    const modelProvider = String(req.body?.modelProvider || 'openai');
    const cliVersion = String(req.body?.cliVersion || '0.120.0');
    const id = randomUUID();
    const { filePath, timestamp } = createSessionFile({ id, cwd, title, modelProvider, cliVersion });

    execSqlite(STATE_DB, `
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, cli_version, first_user_message
      ) VALUES (
        ${sqlString(id)},
        ${sqlString(filePath)},
        ${timestamp},
        ${timestamp},
        'cli',
        ${sqlString(modelProvider)},
        ${sqlString(cwd)},
        ${sqlString(title)},
        ${sqlString('{"type":"danger-full-access","writable_roots":[],"network_access":true}')},
        'never',
        ${sqlString(cliVersion)},
        ${sqlString(title)}
      );
    `);

    invalidateCache();
    res.json(readSessionDetail(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/sessions/:id', (req, res) => {
  const title = req.body?.title;
  if (!title) return res.status(400).json({ error: 'Missing title' });
  try {
    execSqlite(STATE_DB, `UPDATE threads SET title = ${sqlString(title)}, updated_at = strftime('%s','now') WHERE id = ${sqlString(req.params.id)};`);
    invalidateCache();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  try {
    const filePath = findSessionFile(req.params.id);
    if (filePath) fs.rmSync(filePath, { force: true });
    execSqlite(STATE_DB, `DELETE FROM threads WHERE id = ${sqlString(req.params.id)};`);
    invalidateCache();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history', (req, res) => {
  const projectPath = req.query.project ? path.resolve(req.query.project) : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const history = readHistoryEntries(limit * 4);

  if (!projectPath) return res.json({ entries: history.slice(0, limit) });

  const allowedIds = new Set(listSessions(projectPath).map(session => session.id));
  res.json({ entries: history.filter(entry => allowedIds.has(entry.sessionId)).slice(0, limit) });
});

app.get('/api/stats/tools', (req, res) => {
  const projectPath = req.query.project || null;
  const days = parseInt(req.query.days, 10) || 30;
  res.json(countToolUsage(projectPath, {
    days,
    from: req.query.from || null,
    to: req.query.to || null
  }));
});

app.get('/api/stats/usage', (req, res) => {
  const projectPath = req.query.project || null;
  const days = parseInt(req.query.days, 10) || 14;
  res.json(buildUsageStats(projectPath, {
    days,
    from: req.query.from || null,
    to: req.query.to || null
  }));
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  sseClients.add(res);

  req.on('close', () => sseClients.delete(res));
});

app.listen(PORT, () => {
  console.log('\n  Codex Map');
  console.log('  ─────────');
  console.log(`  http://localhost:${PORT}\n`);
});

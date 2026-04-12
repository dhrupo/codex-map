const State = {
  mode: 'global',
  projectPath: '',
  currentTab: 'overview',
  theme: 'light',
  scan: null,
  analysis: null,
  history: [],
  sessions: [],
  sessionDetail: null,
  activeSessionId: null,
  toolStats: null,
  usageStats: null,
  pluginData: null,
  pinnedProjects: [],
  projectStatuses: {},
  rawSelectedPath: null,
  rawFile: null,
  rawEditMode: false,
  rawDraft: '',
  configDraft: '',
  browserPath: null,
  skillDraft: null
};

const TABS_GLOBAL = ['overview', 'stats', 'skills', 'sessions', 'config', 'plugins', 'raw'];
const TABS_PROJECT = ['map', 'overview', 'stats', 'skills', 'sessions', 'config', 'raw'];

const API = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return res.json();
  },
  async send(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return res.json();
  }
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsQuote(value) {
  return JSON.stringify(String(value || ''));
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function currentTabs() {
  return State.mode === 'project' ? TABS_PROJECT : TABS_GLOBAL;
}

function statusLabel(status) {
  return ({ full: 'Full', partial: 'Partial', none: 'Empty', missing: 'Missing' }[status] || status || '—');
}

function getCurrentTree() {
  return State.mode === 'project' ? State.scan?.project?.fileTree : State.scan?.global?.fileTree;
}

async function init() {
  const savedTheme = localStorage.getItem('codex-map-theme') || 'light';
  applyTheme(savedTheme);
  await loadPinnedProjects();
  await loadCurrentView();
  connectEvents();
}

async function loadCurrentView() {
  const projectQuery = State.mode === 'project' ? `?project=${encodeURIComponent(State.projectPath)}` : '';
  State.scan = await API.get(`/api/scan${projectQuery}`);
  State.history = (await API.get(`/api/history${projectQuery}`)).entries || [];
  State.toolStats = await API.get(`/api/stats/tools${projectQuery}`);
  State.usageStats = await API.get(`/api/stats/usage${projectQuery}`);
  State.pluginData = await API.get('/api/plugins');

  if (State.mode === 'project') {
    State.analysis = await API.get(`/api/analyze?project=${encodeURIComponent(State.projectPath)}`);
  } else {
    State.analysis = null;
  }

  const sessionRes = await API.get(`/api/sessions${projectQuery}`);
  State.sessions = sessionRes.sessions || [];
  if (!State.activeSessionId || !State.sessions.find(item => item.id === State.activeSessionId)) {
    State.activeSessionId = State.sessions[0]?.id || null;
  }
  State.sessionDetail = State.activeSessionId
    ? await API.get(`/api/sessions/${encodeURIComponent(State.activeSessionId)}`)
    : null;

  State.configDraft = State.scan?.global?.config?.raw || '';
  render();
}

async function loadPinnedProjects() {
  const res = await API.get('/api/pinned-projects');
  State.pinnedProjects = res.projects || [];
  await refreshProjectStatuses();
  renderProjectList();
}

async function refreshProjectStatuses() {
  const statuses = await Promise.all(State.pinnedProjects.map(async projectPath => {
    try {
      const res = await API.get(`/api/project-status?path=${encodeURIComponent(projectPath)}`);
      return [projectPath, res.status];
    } catch {
      return [projectPath, 'missing'];
    }
  }));
  State.projectStatuses = Object.fromEntries(statuses);
}

function applyTheme(theme) {
  State.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('codex-map-theme', theme);
  document.getElementById('hljs-light').disabled = theme === 'dark';
  document.getElementById('hljs-dark').disabled = theme !== 'dark';
}

function toggleTheme() {
  applyTheme(State.theme === 'light' ? 'dark' : 'light');
}

function selectGlobal() {
  State.mode = 'global';
  State.projectPath = '';
  State.currentTab = 'overview';
  State.activeSessionId = null;
  loadCurrentView();
}

function selectProject(projectPath) {
  State.mode = 'project';
  State.projectPath = projectPath;
  State.currentTab = 'map';
  State.activeSessionId = null;
  loadCurrentView();
}

async function addPinnedProject(projectPath) {
  await API.send('/api/pinned-projects', 'POST', { path: projectPath });
  await loadPinnedProjects();
}

async function removePinnedProject(projectPath) {
  await API.send('/api/pinned-projects', 'DELETE', { path: projectPath });
  if (State.projectPath === projectPath) {
    selectGlobal();
  } else {
    await loadPinnedProjects();
  }
}

async function addPath() {
  const input = document.getElementById('path-input');
  const value = input.value.trim();
  if (!value) return;
  await addPinnedProject(value);
  input.value = '';
}

function render() {
  renderProjectList();
  renderHero();
  renderTabs();
  renderContent();
  document.getElementById('scan-meta').textContent = State.scan?.meta ? `Scan ${State.scan.meta.scanDurationMs}ms` : '';
}

function renderProjectList() {
  const list = document.getElementById('project-list');
  list.innerHTML = State.pinnedProjects.length ? State.pinnedProjects.map(projectPath => `
    <div class="project-item ${State.projectPath === projectPath ? 'active' : ''}">
      <button class="project-main" onclick='selectProject(${jsQuote(projectPath)})' title="${escapeHtml(projectPath)}">
        <span class="status-pill ${escapeHtml(State.projectStatuses[projectPath] || 'none')}">${escapeHtml(statusLabel(State.projectStatuses[projectPath]))}</span>
        <span class="project-name">${escapeHtml(projectPath.split('/').pop() || projectPath)}</span>
      </button>
      <button class="ghost" onclick='removePinnedProject(${jsQuote(projectPath)})'>×</button>
    </div>
  `).join('') : '<p class="muted">No pinned projects yet.</p>';
}

function renderHero() {
  const heroTitle = document.getElementById('hero-title');
  const heroSubtitle = document.getElementById('hero-subtitle');
  const metrics = document.getElementById('hero-metrics');

  if (State.mode === 'project') {
    const project = State.analysis?.project;
    heroTitle.textContent = State.scan?.project?.projectName || 'Project';
    heroSubtitle.textContent = 'Project-local instructions, skills, MCP, sessions, raw files, and trust state in one place.';
    metrics.innerHTML = [
      metricCard('Trust', project?.trustLevel || 'unlisted'),
      metricCard('Sessions', formatNumber(project?.sessionCount || 0)),
      metricCard('Skills', formatNumber(State.scan?.project?.localSkills?.length || 0)),
      metricCard('Status', statusLabel(project?.status))
    ].join('');
    return;
  }

  heroTitle.textContent = 'Your Codex setup, finally visible.';
  heroSubtitle.textContent = 'Inspect ~/.codex, edit config and MCP, manage skills and plugins, browse sessions, and save raw files without leaving the dashboard.';
  metrics.innerHTML = [
    metricCard('Projects', formatNumber(State.scan?.global?.projects?.length || 0)),
    metricCard('Skills', formatNumber(State.scan?.global?.skills?.length || 0)),
    metricCard('Sessions', formatNumber(State.scan?.global?.sessionSummary?.total || 0)),
    metricCard('Plugins', formatNumber(State.pluginData?.plugins?.length || 0))
  ].join('');
}

function metricCard(label, value) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function renderTabs() {
  document.getElementById('tabs').innerHTML = currentTabs().map(tab => `
    <button class="tab ${State.currentTab === tab ? 'active' : ''}" aria-pressed="${State.currentTab === tab}" onclick='setTab(${jsQuote(tab)})'>${escapeHtml(tab)}</button>
  `).join('');
}

function setTab(tab) {
  State.currentTab = tab;
  renderTabs();
  renderContent();
}

function renderContent() {
  const html = {
    map: renderMap(),
    overview: renderOverview(),
    stats: renderStats(),
    skills: renderSkills(),
    sessions: renderSessions(),
    config: renderConfig(),
    plugins: renderPlugins(),
    raw: renderRaw()
  }[State.currentTab] || '<p class="muted">Nothing here yet.</p>';

  document.getElementById('content').innerHTML = html;
  highlightCode();
}

function panel(title, body, actions = '') {
  return `
    <section class="panel">
      <div class="panel-head">
        <h3>${escapeHtml(title)}</h3>
        ${actions}
      </div>
      <div class="panel-body">${body}</div>
    </section>
  `;
}

function renderMap() {
  const project = State.analysis?.project;
  const connections = State.analysis?.connections;
  if (!project) return '<p class="muted">Project map unavailable.</p>';

  return `
    <div class="grid two">
      ${panel('Global', `
        <div class="kv"><span>Skills</span><strong>${formatNumber(connections?.global?.skills?.count || 0)}</strong></div>
        <div class="kv"><span>MCP Servers</span><strong>${formatNumber(connections?.global?.mcp?.count || 0)}</strong></div>
        <div class="kv"><span>Trusted Projects</span><strong>${formatNumber(connections?.global?.projects?.count || 0)}</strong></div>
        <div class="kv"><span>Plugins</span><strong>${formatNumber(connections?.global?.plugins?.count || 0)}</strong></div>
      `)}
      ${panel('Project', `
        <div class="kv"><span>AGENTS.md</span><strong>${project.hasAgentsMd ? 'Present' : 'Missing'}</strong></div>
        <div class="kv"><span>.codex/</span><strong>${project.hasCodexDir ? 'Present' : 'Missing'}</strong></div>
        <div class="kv"><span>.mcp.json</span><strong>${project.hasMcpJson ? 'Present' : 'Missing'}</strong></div>
        <div class="kv"><span>Trust</span><strong>${escapeHtml(project.trustLevel || 'unlisted')}</strong></div>
        <div class="kv"><span>Sessions</span><strong>${formatNumber(project.sessionCount || 0)}</strong></div>
      `)}
    </div>
    ${project.warnings?.length ? panel('Warnings', `<ul class="plain-list">${project.warnings.map(item => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>`) : ''}
  `;
}

function renderOverview() {
  return State.mode === 'project' ? renderProjectOverview() : renderGlobalOverview();
}

function renderGlobalOverview() {
  const global = State.scan?.global || {};
  const config = global.config || {};
  return `
    <div class="grid two">
      ${panel('Codex Home', `
        <div class="kv"><span>Path</span><strong>${escapeHtml(State.scan?.meta?.globalPath || '—')}</strong></div>
        <div class="kv"><span>Approvals Reviewer</span><strong>${escapeHtml(config.approvalsReviewer || '—')}</strong></div>
        <div class="kv"><span>Personality</span><strong>${escapeHtml(config.personality || '—')}</strong></div>
        <div class="kv"><span>Profiles</span><strong>${formatNumber(config.profiles?.length || 0)}</strong></div>
      `)}
      ${panel('Configured Projects', (global.projects || []).length ? `
        <div class="chart-list">
          ${global.projects.map(project => `
            <div class="project-row">
              <span>${escapeHtml(project.name)}</span>
              <span>${escapeHtml(project.trustLevel || 'unlisted')}</span>
              <span>${formatNumber(project.sessionCount || 0)} sessions</span>
            </div>
          `).join('')}
        </div>
      ` : '<p class="muted">No trusted projects found in config.toml.</p>')}
    </div>
    ${global.agentsMd ? panel('Global AGENTS.md', markdownCard(global.agentsMd.raw, true)) : ''}
  `;
}

function renderProjectOverview() {
  const project = State.scan?.project || {};
  const analysis = State.analysis?.project || {};
  return `
    <div class="grid two">
      ${panel('Project Snapshot', `
        <div class="kv"><span>Path</span><strong>${escapeHtml(project.path || '—')}</strong></div>
        <div class="kv"><span>Trust</span><strong>${escapeHtml(project.trustLevel || 'unlisted')}</strong></div>
        <div class="kv"><span>Sessions</span><strong>${formatNumber(analysis.sessionCount || 0)}</strong></div>
        <div class="kv"><span>Skills</span><strong>${formatNumber(project.localSkills?.length || 0)}</strong></div>
      `)}
      ${panel('Project Config', `
        <div class="kv"><span>AGENTS.md</span><strong>${project.agentsMd ? 'Present' : 'Missing'}</strong></div>
        <div class="kv"><span>.codex/</span><strong>${project.hasCodexDir ? 'Present' : 'Missing'}</strong></div>
        <div class="kv"><span>MCP Servers</span><strong>${formatNumber(project.mcpJson?.servers?.length || 0)}</strong></div>
      `)}
    </div>
    ${project.agentsMd ? panel('Project AGENTS.md', markdownCard(project.agentsMd.raw, true)) : ''}
  `;
}

function renderStats() {
  const usage = State.usageStats || { daily: [], topTools: [] };
  return `
    <div class="grid two">
      ${panel('Usage Trend', usage.daily?.length ? usageChart(usage.daily) : '<p class="muted">No recent usage data.</p>')}
      ${panel('Top Tools', usage.topTools?.length ? toolChart(usage.topTools) : '<p class="muted">No tool usage data.</p>')}
    </div>
  `;
}

function usageChart(rows) {
  const width = 680;
  const height = 220;
  const max = Math.max(...rows.map(row => Math.max(row.prompts, row.sessions, 1)), 1);
  const step = width / Math.max(rows.length, 1);
  return `
    <div class="chart-wrap">
      <div class="chip-row">
        <span class="chip">Prompts</span>
        <span class="chip">Sessions</span>
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Usage trend chart">
        <line x1="0" y1="170" x2="${width}" y2="170" stroke="var(--panel-border)"></line>
        ${rows.map((row, index) => {
          const x = index * step + 10;
          const promptH = (row.prompts / max) * 130;
          const sessionH = (row.sessions / max) * 130;
          const bar = Math.max(step / 3, 12);
          return `
            <g>
              <rect x="${x}" y="${170 - promptH}" width="${bar}" height="${promptH}" fill="var(--brand)" rx="6"></rect>
              <rect x="${x + bar + 6}" y="${170 - sessionH}" width="${bar}" height="${sessionH}" fill="var(--accent)" rx="6"></rect>
              <text x="${x}" y="198" fill="var(--muted)" font-size="11">${row.date.slice(5)}</text>
            </g>
          `;
        }).join('')}
      </svg>
      <div class="chart-list">
        ${rows.map(row => `<div class="kv"><span>${escapeHtml(row.date)}</span><strong>${row.prompts} prompts · ${row.sessions} sessions · ${row.tools} tools</strong></div>`).join('')}
      </div>
    </div>
  `;
}

function toolChart(rows) {
  const max = Math.max(...rows.map(row => row.count), 1);
  return `
    <div class="chart-list">
      ${rows.map(row => `
        <div class="tool-row">
          <span>${escapeHtml(row.name)}</span>
          <div class="tool-bar"><i style="width:${(row.count / max) * 100}%"></i></div>
          <strong>${row.count}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSkills() {
  const globalSkills = State.scan?.global?.skills || [];
  const localSkills = State.scan?.project?.localSkills || [];
  const localSet = new Set(localSkills.map(skill => skill.name));

  return `
    <div class="grid two">
      ${panel('Global Skills', globalSkills.length ? globalSkills.map(skill => skillCard(skill, localSet.has(skill.name) ? 'shared' : 'global', 'global')).join('') : '<p class="muted">No global skills found.</p>', `<button class="btn btn-small" onclick='newSkill("global")'>New global skill</button>`)}
      ${panel('Project Skills', localSkills.length ? localSkills.map(skill => skillCard(skill, 'project', 'project')).join('') : '<p class="muted">No project-local skills found in .codex/skills.</p>', State.mode === 'project' ? `<button class="btn btn-small" onclick='newSkill("project")'>New project skill</button>` : '')}
    </div>
  `;
}

function skillCard(skill, tone, scope) {
  const chips = [tone, ...(skill.meta?.allowedTools || []).slice(0, 3)]
    .map(chip => `<span class="chip">${escapeHtml(chip)}</span>`).join('');

  return `
    <article class="skill-card">
      <div class="skill-head">
        <strong>${escapeHtml(skill.meta?.displayName || skill.name)}</strong>
        <div class="chip-row">${chips}</div>
      </div>
      <p>${escapeHtml(skill.meta?.description || skill.excerpt || 'No description.')}</p>
      <div class="chip-row">
        <button class="btn btn-small" onclick='editSkill(${jsQuote(scope)}, ${jsQuote(skill.name)})'>Edit</button>
        <button class="ghost" onclick='removeSkill(${jsQuote(scope)}, ${jsQuote(skill.name)})'>Delete</button>
      </div>
      ${skill.meta?.argumentHint ? `<small>Arguments: ${escapeHtml(skill.meta.argumentHint)}</small>` : ''}
    </article>
  `;
}

function renderSessions() {
  const history = State.history || [];
  return `
    ${panel('Session Browser', State.sessions.length ? `
      <div class="session-browser">
        <div class="session-master">
          ${State.sessions.map(session => `
            <button class="session-card ${State.activeSessionId === session.id ? 'selected' : ''}" onclick='openSession(${jsQuote(session.id)})'>
              <strong>${escapeHtml(session.title)}</strong>
              <span>${escapeHtml(session.cwd || 'Unknown cwd')}</span>
              <div class="chip-row">
                <span class="chip">${formatNumber(session.messageCount)} msgs</span>
                <span class="chip">${formatNumber(session.toolCallCount)} tools</span>
                <span class="chip">${escapeHtml(formatDate(session.updatedAt))}</span>
              </div>
            </button>
          `).join('')}
        </div>
        <div class="session-detail-wrap">
          ${State.sessionDetail ? renderSessionDetail() : '<p class="muted">Select a session.</p>'}
        </div>
      </div>
    ` : '<p class="muted">No sessions found for this scope.</p>', `<button class="btn btn-small" onclick='createSession()'>New session</button>`)}
    ${panel('Prompt History', history.length ? `
      <div class="history-list">
        ${history.slice(0, 24).map(entry => `
          <article class="history-item">
            <small>${escapeHtml(formatDate(entry.timestamp))}</small>
            <p>${escapeHtml(entry.text)}</p>
          </article>
        `).join('')}
      </div>
    ` : '<p class="muted">No prompt history found.</p>')}
  `;
}

async function openSession(sessionId) {
  State.activeSessionId = sessionId;
  State.sessionDetail = await API.get(`/api/sessions/${encodeURIComponent(sessionId)}`);
  renderContent();
}

function renderSessionDetail() {
  const detail = State.sessionDetail;
  const tools = Object.entries(detail.summary?.toolBreakdown || {})
    .map(([name, count]) => `<span class="chip">${escapeHtml(name)} ${count}</span>`).join('');

  return `
    <div class="eyebrow">Session Detail</div>
    <h2>${escapeHtml(detail.session.title || '(untitled session)')}</h2>
    <div class="session-meta">
      <div class="kv"><span>Session</span><strong>${escapeHtml(detail.session.id)}</strong></div>
      <div class="kv"><span>Path</span><strong>${escapeHtml(detail.session.cwd || '—')}</strong></div>
      <div class="kv"><span>Provider</span><strong>${escapeHtml(detail.session.modelProvider || '—')}</strong></div>
      <div class="kv"><span>Updated</span><strong>${escapeHtml(formatDate(detail.session.updatedAt))}</strong></div>
    </div>
    <div class="panel-actions-inline">
      <button class="btn btn-small" onclick='copyResumeCommand(${jsQuote(detail.session.id)})'>Copy resume command</button>
      <button class="btn btn-small" onclick='renameSession(${jsQuote(detail.session.id)})'>Rename</button>
      <button class="ghost" onclick='deleteSession(${jsQuote(detail.session.id)})'>Delete</button>
      <span class="chip-row">${tools || '<span class="chip">No tool events</span>'}</span>
    </div>
    <div class="timeline">
      ${(detail.timeline || []).map(item => `
        <article class="timeline-item ${item.kind}">
          <small>${escapeHtml(formatDate(item.timestamp))}</small>
          <strong>${escapeHtml(item.title)}</strong>
          <pre>${escapeHtml(item.body || '')}</pre>
        </article>
      `).join('')}
    </div>
  `;
}

function copyResumeCommand(sessionId) {
  navigator.clipboard?.writeText(`codex resume ${sessionId}`);
}

async function createSession() {
  const title = window.prompt('Session title', 'New session');
  if (!title) return;
  const cwd = window.prompt('Working directory', State.projectPath || '/Volumes/Projects');
  if (!cwd) return;
  const detail = await API.send('/api/sessions', 'POST', { title, cwd });
  State.activeSessionId = detail?.session?.id || null;
  await loadCurrentView();
}

async function renameSession(sessionId) {
  const current = State.sessionDetail?.session?.title || '';
  const next = window.prompt('New session title', current);
  if (!next || next === current) return;
  await API.send(`/api/sessions/${encodeURIComponent(sessionId)}`, 'PUT', { title: next });
  await loadCurrentView();
}

async function deleteSession(sessionId) {
  if (!window.confirm('Delete this session and its local log file?')) return;
  await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  await loadCurrentView();
}

function renderConfig() {
  return State.mode === 'project' ? renderProjectConfig() : renderGlobalConfig();
}

function renderGlobalConfig() {
  const config = State.scan?.global?.config;
  if (!config) return '<p class="muted">No ~/.codex/config.toml found.</p>';

  return `
    <div class="grid two">
      ${panel('config.toml Summary', `
        <div class="kv"><span>Approvals Reviewer</span><strong>${escapeHtml(config.approvalsReviewer || '—')}</strong></div>
        <div class="kv"><span>Personality</span><strong>${escapeHtml(config.personality || '—')}</strong></div>
        <div class="kv"><span>MCP Servers</span><strong>${formatNumber(config.mcpServers?.length || 0)}</strong></div>
        <div class="kv"><span>Profiles</span><strong>${formatNumber(config.profiles?.length || 0)}</strong></div>
      `, `<button class="btn btn-small" onclick='saveConfig()'>Save</button>`)}
      ${panel('Trusted Projects', config.projects?.length ? config.projects.map(project => `
        <article class="mini-card">
          <strong>${escapeHtml(project.path)}</strong>
          <p>${escapeHtml(project.trustLevel || 'unlisted')}</p>
          <div class="chip-row">
            <button class="btn btn-small" onclick='editConfigProject(${jsQuote(project.path)})'>Edit</button>
            <button class="ghost" onclick='deleteConfigProject(${jsQuote(project.path)})'>Delete</button>
          </div>
        </article>
      `).join('') : '<p class="muted">No trusted projects configured.</p>', `<button class="btn btn-small" onclick='createConfigProject()'>Add project</button>`)}
    </div>
    <div class="grid two">
      ${panel('MCP Servers', config.mcpServers?.length ? config.mcpServers.map(server => `
        <article class="mini-card">
          <strong>${escapeHtml(server.name)}</strong>
          <p>${escapeHtml(server.command || '—')} ${escapeHtml((server.args || []).join(' '))}</p>
          <div class="chip-row">
            <button class="btn btn-small" onclick='editMcpServer(${jsQuote(server.name)})'>Edit</button>
            <button class="ghost" onclick='deleteMcpServer(${jsQuote(server.name)})'>Delete</button>
          </div>
        </article>
      `).join('') : '<p class="muted">No MCP servers configured.</p>', `<button class="btn btn-small" onclick='createMcpServer()'>New MCP</button>`)}
    </div>
    ${panel('Raw config.toml', `<textarea id="config-editor" class="skill-textarea">${escapeHtml(State.configDraft || config.raw || '')}</textarea>`)}
  `;
}

function renderProjectConfig() {
  const project = State.scan?.project;
  if (!project) return '<p class="muted">No project selected.</p>';

  return `
    <div class="grid two">
      ${panel('Project Instructions', project.agentsMd ? markdownCard(project.agentsMd.raw, true) : '<p class="muted">No AGENTS.md found.</p>')}
      ${panel('Project MCP', project.mcpJson ? codeBlock(project.mcpJson.raw, 'json') : '<p class="muted">No .mcp.json found.</p>')}
    </div>
  `;
}

async function saveConfig() {
  const raw = document.getElementById('config-editor')?.value;
  if (typeof raw !== 'string') return;
  await API.send('/api/config', 'PUT', { raw });
  await loadCurrentView();
}

async function createMcpServer() {
  const name = window.prompt('MCP server name');
  if (!name) return;
  const command = window.prompt('Command', 'npx');
  if (!command) return;
  const argsText = window.prompt('Args (space-separated)', '') || '';
  const cwd = window.prompt('Working directory (optional)', '') || '';
  await API.send('/api/config/mcp', 'POST', {
    name,
    command,
    args: argsText.split(/\s+/).filter(Boolean),
    cwd: cwd || undefined
  });
  await loadCurrentView();
}

async function editMcpServer(name) {
  const server = (State.scan?.global?.config?.mcpServers || []).find(item => item.name === name);
  if (!server) return;
  const newName = window.prompt('MCP server name', server.name);
  if (!newName) return;
  const command = window.prompt('Command', server.command || '');
  if (!command) return;
  const argsText = window.prompt('Args (space-separated)', (server.args || []).join(' ')) || '';
  const cwd = window.prompt('Working directory (optional)', server.cwd || '') || '';
  await API.send(`/api/config/mcp/${encodeURIComponent(name)}`, 'PUT', {
    newName,
    command,
    args: argsText.split(/\s+/).filter(Boolean),
    cwd: cwd || undefined
  });
  await loadCurrentView();
}

async function deleteMcpServer(name) {
  if (!window.confirm(`Delete MCP server "${name}"?`)) return;
  await fetch(`/api/config/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await loadCurrentView();
}

async function createConfigProject() {
  const projectPath = window.prompt('Project path');
  if (!projectPath) return;
  const trustLevel = window.prompt('Trust level', 'trusted') || 'trusted';
  await API.send('/api/config/projects', 'POST', { path: projectPath, trustLevel });
  await loadCurrentView();
}

async function editConfigProject(projectPath) {
  const project = (State.scan?.global?.config?.projects || []).find(item => item.path === projectPath);
  if (!project) return;
  const trustLevel = window.prompt('Trust level', project.trustLevel || 'trusted') || project.trustLevel || 'trusted';
  await API.send('/api/config/projects', 'PUT', { path: projectPath, trustLevel });
  await loadCurrentView();
}

async function deleteConfigProject(projectPath) {
  if (!window.confirm(`Delete trusted project "${projectPath}"?`)) return;
  await fetch('/api/config/projects', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath })
  });
  await loadCurrentView();
}

function renderPlugins() {
  const plugins = State.pluginData?.plugins || [];
  const activity = Object.entries(State.toolStats?.toolUsage || {})
    .map(([name, count]) => `<div class="kv"><span>${escapeHtml(name)}</span><strong>${formatNumber(count)}</strong></div>`).join('');

  return `
    <div class="grid two">
      ${panel('Installed Plugins', plugins.length ? plugins.map(plugin => `
        <article class="mini-card">
          <strong>${escapeHtml(plugin.displayName || plugin.name)}</strong>
          <p>${escapeHtml(plugin.description || 'No description.')}</p>
          <small>${escapeHtml(plugin.version || 'no version')} · ${plugin.tools} tools · ${plugin.prompts} prompts · ${escapeHtml(plugin.category || 'Custom')}</small>
          <div class="chip-row">
            <button class="btn btn-small" onclick='editPlugin(${jsQuote(plugin.name)})'>Edit</button>
            <button class="ghost" onclick='deletePlugin(${jsQuote(plugin.name)})'>Delete</button>
          </div>
        </article>
      `).join('') : '<p class="muted">No plugin manifests detected.</p>', `<button class="btn btn-small" onclick='createPlugin()'>New plugin</button>`)}
      ${panel('Tool Activity', activity || '<p class="muted">No recent tool events.</p>')}
    </div>
  `;
}

async function createPlugin() {
  const name = window.prompt('Plugin id/name');
  if (!name) return;
  const displayName = window.prompt('Display name', name) || name;
  const description = window.prompt('Description', '') || '';
  const category = window.prompt('Category', 'Custom') || 'Custom';
  await API.send('/api/plugins', 'POST', {
    name,
    displayName,
    description,
    category,
    capabilities: ['Interactive'],
    defaultPrompt: ['Use this plugin from Codex Map']
  });
  await loadCurrentView();
}

async function editPlugin(name) {
  const plugin = (State.pluginData?.plugins || []).find(item => item.name === name);
  if (!plugin) return;
  const newName = window.prompt('Plugin id/name', plugin.name);
  if (!newName) return;
  const displayName = window.prompt('Display name', plugin.displayName || plugin.name) || plugin.name;
  const description = window.prompt('Description', plugin.description || '') || '';
  const category = window.prompt('Category', plugin.category || 'Custom') || 'Custom';
  await API.send(`/api/plugins/${encodeURIComponent(name)}`, 'PUT', {
    name: newName,
    displayName,
    description,
    category,
    capabilities: ['Interactive'],
    defaultPrompt: ['Use this plugin from Codex Map'],
    version: plugin.version || '0.1.0'
  });
  await loadCurrentView();
}

async function deletePlugin(name) {
  if (!window.confirm(`Delete plugin "${name}"?`)) return;
  await fetch(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await loadCurrentView();
}

function renderRaw() {
  const tree = getCurrentTree();
  return `
    <div class="grid two raw-grid">
      ${panel('File Tree', tree ? renderTree(tree) : '<p class="muted">No file tree available.</p>')}
      ${panel('File Viewer', State.rawFile ? renderRawEditor() : '<p class="muted">Choose a file to preview.</p>')}
    </div>
  `;
}

function renderTree(node, depth = 0) {
  if (!node) return '';
  const indent = depth * 14;
  if (!node.isDir) {
    return `<button class="tree-file" style="padding-left:${indent}px" onclick='openFile(${jsQuote(node.path)})'>${escapeHtml(node.name)}</button>`;
  }

  return `
    <div class="tree-dir" style="padding-left:${indent}px">${escapeHtml(node.name)}</div>
    ${(node.children || []).map(child => renderTree(child, depth + 1)).join('')}
  `;
}

async function openFile(filePath) {
  State.rawSelectedPath = filePath;
  const projectQuery = State.mode === 'project' ? `&project=${encodeURIComponent(State.projectPath)}` : '';
  State.rawFile = await API.get(`/api/file?path=${encodeURIComponent(filePath)}${projectQuery}`);
  State.rawEditMode = false;
  State.rawDraft = State.rawFile.content || '';
  renderContent();
}

function renderRawEditor() {
  return `
    <div class="panel-actions-inline">
      <button class="btn btn-small" onclick='toggleRawEdit()'>${State.rawEditMode ? 'Preview' : 'Edit'}</button>
      ${State.rawEditMode ? `<button class="btn btn-small" onclick='saveRawFile()'>Save</button>` : ''}
      <span class="chip">${escapeHtml(State.rawSelectedPath || '')}</span>
    </div>
    ${State.rawEditMode
      ? `<textarea id="raw-editor" class="skill-textarea">${escapeHtml(State.rawDraft || '')}</textarea>`
      : codeBlock(State.rawFile.content || '', detectLanguage(State.rawSelectedPath))}
  `;
}

function toggleRawEdit() {
  if (!State.rawFile) return;
  if (State.rawEditMode) {
    State.rawDraft = document.getElementById('raw-editor')?.value || State.rawDraft;
  }
  State.rawEditMode = !State.rawEditMode;
  renderContent();
}

async function saveRawFile() {
  const content = document.getElementById('raw-editor')?.value;
  if (typeof content !== 'string') return;
  await API.send('/api/file', 'PUT', {
    path: State.rawSelectedPath,
    content,
    projectPath: State.mode === 'project' ? State.projectPath : null
  });
  State.rawFile.content = content;
  State.rawDraft = content;
  State.rawEditMode = false;
  renderContent();
}

function markdownCard(content, compact = false) {
  return `<div class="markdown-body ${compact ? 'markdown-compact' : ''}">${marked.parse(content || '')}</div>`;
}

function codeBlock(content, language) {
  return `<pre><code class="language-${language}">${escapeHtml(content || '')}</code></pre>`;
}

function detectLanguage(filePath) {
  if (!filePath) return 'plaintext';
  if (filePath.endsWith('.json')) return 'json';
  if (filePath.endsWith('.md')) return 'markdown';
  if (filePath.endsWith('.toml')) return 'ini';
  if (filePath.endsWith('.js')) return 'javascript';
  return 'plaintext';
}

function highlightCode() {
  document.querySelectorAll('pre code').forEach(block => {
    try {
      hljs.highlightElement(block);
    } catch {}
  });
}

function downloadExport() {
  const projectQuery = State.mode === 'project' ? `?project=${encodeURIComponent(State.projectPath)}` : '';
  window.open(`/api/export${projectQuery}`, '_blank');
}

async function downloadBundle() {
  const res = await fetch('/api/export/bundle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: State.mode === 'project' ? 'project' : 'global',
      projectPath: State.projectPath || null
    })
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `codex-map-bundle-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function openBrowser(startPath) {
  State.browserPath = startPath || State.browserPath || '/Volumes/Projects';
  document.getElementById('browser-modal').classList.remove('hidden');
  await renderBrowser();
}

function closeBrowser() {
  document.getElementById('browser-modal').classList.add('hidden');
}

async function renderBrowser() {
  const data = await API.get(`/api/browse?path=${encodeURIComponent(State.browserPath)}`);
  document.getElementById('browser-crumbs').innerHTML = data.crumbs.map(crumb => `
    <button class="crumb" onclick='openBrowser(${jsQuote(crumb.path)})'>${escapeHtml(crumb.name)}</button>
  `).join('');

  const bookmarks = await API.get('/api/browse/bookmarks');
  document.getElementById('browser-bookmarks').innerHTML = bookmarks.bookmarks.map(mark => `
    <button class="bookmark" onclick='openBrowser(${jsQuote(mark.path)})'>${escapeHtml(mark.name)}</button>
  `).join('');

  document.getElementById('browser-list').innerHTML = `
    ${data.parent ? `<button class="browser-item" onclick='openBrowser(${jsQuote(data.parent)})'>..</button>` : ''}
    ${data.dirs.map(dir => `
      <div class="browser-row">
        <button class="browser-item" onclick='openBrowser(${jsQuote(dir.path)})'>${escapeHtml(dir.name)}</button>
        <button class="btn btn-small" onclick='chooseBrowserPath(${jsQuote(dir.path)})'>Select</button>
      </div>
    `).join('')}
  `;
}

async function chooseBrowserPath(projectPath) {
  await addPinnedProject(projectPath);
  closeBrowser();
}

function openSkillModal() {
  document.getElementById('skill-modal').classList.remove('hidden');
}

function closeSkillModal() {
  document.getElementById('skill-modal').classList.add('hidden');
}

function currentSkillProjectPath(scope) {
  return scope === 'project' ? State.projectPath : null;
}

function newSkill(scope) {
  if (scope === 'project' && State.mode !== 'project') return;
  State.skillDraft = { mode: 'create', scope, originalName: '' };
  document.getElementById('skill-modal-title').textContent = `New ${scope} skill`;
  document.getElementById('skill-name-input').value = '';
  document.getElementById('skill-content-input').value = '';
  document.getElementById('skill-scope-label').textContent = scope === 'project' ? `Project: ${State.projectPath}` : 'Global skill';
  document.getElementById('skill-delete-btn').style.display = 'none';
  openSkillModal();
}

async function editSkill(scope, name) {
  const qs = new URLSearchParams({ scope });
  const projectPath = currentSkillProjectPath(scope);
  if (projectPath) qs.set('projectPath', projectPath);
  const skill = await API.get(`/api/skills/${encodeURIComponent(name)}?${qs.toString()}`);
  State.skillDraft = { mode: 'edit', scope, originalName: name };
  document.getElementById('skill-modal-title').textContent = `Edit ${name}`;
  document.getElementById('skill-name-input').value = name;
  document.getElementById('skill-content-input').value = skill.content || '';
  document.getElementById('skill-scope-label').textContent = scope === 'project' ? `Project: ${State.projectPath}` : 'Global skill';
  document.getElementById('skill-delete-btn').style.display = 'inline-block';
  openSkillModal();
}

async function saveSkill() {
  const draft = State.skillDraft;
  if (!draft) return;
  const name = document.getElementById('skill-name-input').value.trim();
  const content = document.getElementById('skill-content-input').value;
  if (!name || !content) return;

  const body = { name, content, scope: draft.scope, projectPath: currentSkillProjectPath(draft.scope) };
  if (draft.mode === 'create') {
    await API.send('/api/skills', 'POST', body);
  } else if (name === draft.originalName) {
    await API.send(`/api/skills/${encodeURIComponent(draft.originalName)}`, 'PUT', body);
  } else {
    await API.send('/api/skills', 'POST', body);
    const qs = new URLSearchParams({ scope: draft.scope });
    const projectPath = currentSkillProjectPath(draft.scope);
    if (projectPath) qs.set('projectPath', projectPath);
    await fetch(`/api/skills/${encodeURIComponent(draft.originalName)}?${qs.toString()}`, { method: 'DELETE' });
  }
  closeSkillModal();
  await loadCurrentView();
}

async function deleteSkill() {
  const draft = State.skillDraft;
  if (!draft) return;
  const qs = new URLSearchParams({ scope: draft.scope });
  const projectPath = currentSkillProjectPath(draft.scope);
  if (projectPath) qs.set('projectPath', projectPath);
  await fetch(`/api/skills/${encodeURIComponent(draft.originalName)}?${qs.toString()}`, { method: 'DELETE' });
  closeSkillModal();
  await loadCurrentView();
}

async function removeSkill(scope, name) {
  await editSkill(scope, name);
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('connected', () => {
    document.getElementById('sse-status').textContent = 'Live sync on';
  });
  source.addEventListener('file-changed', () => {
    document.getElementById('sse-status').textContent = 'Syncing…';
    loadCurrentView().finally(() => {
      document.getElementById('sse-status').textContent = 'Live sync on';
    });
  });
  source.onerror = () => {
    document.getElementById('sse-status').textContent = 'Live sync off';
  };
}

window.toggleTheme = toggleTheme;
window.selectGlobal = selectGlobal;
window.selectProject = selectProject;
window.setTab = setTab;
window.addPath = addPath;
window.removePinnedProject = removePinnedProject;
window.openSession = openSession;
window.createSession = createSession;
window.copyResumeCommand = copyResumeCommand;
window.renameSession = renameSession;
window.deleteSession = deleteSession;
window.saveConfig = saveConfig;
window.createMcpServer = createMcpServer;
window.editMcpServer = editMcpServer;
window.deleteMcpServer = deleteMcpServer;
window.createConfigProject = createConfigProject;
window.editConfigProject = editConfigProject;
window.deleteConfigProject = deleteConfigProject;
window.createPlugin = createPlugin;
window.editPlugin = editPlugin;
window.deletePlugin = deletePlugin;
window.openFile = openFile;
window.toggleRawEdit = toggleRawEdit;
window.saveRawFile = saveRawFile;
window.downloadExport = downloadExport;
window.downloadBundle = downloadBundle;
window.openBrowser = openBrowser;
window.closeBrowser = closeBrowser;
window.chooseBrowserPath = chooseBrowserPath;
window.newSkill = newSkill;
window.editSkill = editSkill;
window.saveSkill = saveSkill;
window.deleteSkill = deleteSkill;
window.closeSkillModal = closeSkillModal;

init();

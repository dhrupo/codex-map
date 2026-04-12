const State = {
  isLoading: true,
  mode: 'global',
  projectPath: '',
  currentTab: 'overview',
  statsRange: null,
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

function showToast(title, body = '', tone = 'success') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.innerHTML = `
    <strong class="toast-title">${escapeHtml(title)}</strong>
    ${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}
  `;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  window.setTimeout(() => {
    toast.classList.remove('visible');
    window.setTimeout(() => toast.remove(), 180);
  }, 2600);
}

async function runOperation(work, successTitle, successBody = '', errorTitle = 'Operation failed') {
  try {
    const result = await work();
    if (successTitle) showToast(successTitle, successBody, 'success');
    return result;
  } catch (error) {
    showToast(errorTitle, error.message || 'Unknown error', 'error');
    throw error;
  }
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

function isoDateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function defaultStatsRange() {
  const end = new Date();
  const start = new Date(end.getTime() - (29 * 24 * 60 * 60 * 1000));
  return {
    from: isoDateOnly(start),
    to: isoDateOnly(end)
  };
}

function statsPresetRange(preset) {
  const now = new Date();
  const end = new Date(now);
  let start = new Date(now);

  if (preset === '7d') {
    start = new Date(end.getTime() - (6 * 24 * 60 * 60 * 1000));
  } else if (preset === '30d') {
    start = new Date(end.getTime() - (29 * 24 * 60 * 60 * 1000));
  } else if (preset === '90d') {
    start = new Date(end.getTime() - (89 * 24 * 60 * 60 * 1000));
  } else if (preset === 'month') {
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  } else if (preset === 'all') {
    const first = State.usageStats?.daily?.find(row => row.prompts || row.sessions || row.tools)?.date;
    return first ? { from: first, to: isoDateOnly(end) } : defaultStatsRange();
  }

  return {
    from: isoDateOnly(start),
    to: isoDateOnly(end)
  };
}

async function init() {
  setLoading(true);
  State.statsRange = defaultStatsRange();
  const savedTheme = localStorage.getItem('codex-map-theme') || 'light';
  applyTheme(savedTheme);
  await loadPinnedProjects();
  await loadCurrentView();
  connectEvents();
  setLoading(false);
}

async function loadCurrentView() {
  try {
    const projectQuery = State.mode === 'project' ? `?project=${encodeURIComponent(State.projectPath)}` : '';
    const statsParams = new URLSearchParams();
    if (State.mode === 'project') statsParams.set('project', State.projectPath);
    if (State.statsRange?.from) statsParams.set('from', State.statsRange.from);
    if (State.statsRange?.to) statsParams.set('to', State.statsRange.to);
    const statsQuery = statsParams.toString() ? `?${statsParams.toString()}` : '';
    State.scan = await API.get(`/api/scan${projectQuery}`);
    State.history = (await API.get(`/api/history${projectQuery}`)).entries || [];
    State.toolStats = await API.get(`/api/stats/tools${statsQuery}`);
    State.usageStats = await API.get(`/api/stats/usage${statsQuery}`);
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
  } finally {
    setLoading(false);
  }
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

function selectProject(projectPath, tab = 'map') {
  State.mode = 'project';
  State.projectPath = projectPath;
  State.currentTab = tab;
  State.activeSessionId = null;
  loadCurrentView();
}

async function addPinnedProject(projectPath) {
  await runOperation(
    () => API.send('/api/pinned-projects', 'POST', { path: projectPath }),
    'Project added',
    projectPath
  );
  await loadPinnedProjects();
}

async function removePinnedProject(projectPath) {
  await runOperation(
    () => API.send('/api/pinned-projects', 'DELETE', { path: projectPath }),
    'Project removed',
    projectPath
  );
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

function setLoading(isLoading) {
  State.isLoading = isLoading;
  document.body.classList.toggle('loading', isLoading);
  document.getElementById('app-loader')?.classList.toggle('hidden', !isLoading);
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
  const summary = buildStatsSummary(usage);
  return `
    <div class="stats-dashboard">
      ${panel('Date Range', `
        <div class="stats-range">
          <label class="stats-field">
            <span>From</span>
            <input id="stats-from" type="date" value="${escapeHtml(State.statsRange?.from || '')}">
          </label>
          <label class="stats-field">
            <span>To</span>
            <input id="stats-to" type="date" value="${escapeHtml(State.statsRange?.to || '')}">
          </label>
          <div class="stats-range-actions">
            <button class="btn btn-small" onclick="applyStatsRange()">Apply</button>
            <button class="ghost" onclick="resetStatsRange()">Last 30 days</button>
          </div>
        </div>
        <div class="stats-presets">
          <button class="ghost" onclick="applyStatsPreset('7d')">7D</button>
          <button class="ghost" onclick="applyStatsPreset('30d')">30D</button>
          <button class="ghost" onclick="applyStatsPreset('90d')">90D</button>
          <button class="ghost" onclick="applyStatsPreset('month')">This Month</button>
          <button class="ghost" onclick="applyStatsPreset('all')">All Time</button>
        </div>
      `)}
      <div class="stats-summary">
        ${summary.map((item, index) => `
          <article class="stat-tile ${index === 0 ? 'emphasis' : ''}">
            <div class="stat-value">${escapeHtml(item.value)}</div>
            <div class="stat-label">${escapeHtml(item.label)}</div>
            ${item.sub ? `<div class="stat-sub">${escapeHtml(item.sub)}</div>` : ''}
          </article>
        `).join('')}
      </div>
      ${panel('Total Usage', usage.daily?.length ? usageChart(usage.daily) : '<p class="muted">No recent usage data.</p>')}
      ${panel('Top Tools', usage.topTools?.length ? toolChart(usage.topTools) : '<p class="muted">No tool usage data.</p>')}
    </div>
  `;
}

function buildStatsSummary(usage) {
  const daily = usage.daily || [];
  const totalMessages = daily.reduce((sum, row) => sum + (row.prompts || 0), 0);
  const totalTools = daily.reduce((sum, row) => sum + (row.tools || 0), 0);
  const totalSessions = daily.reduce((sum, row) => sum + (row.sessions || 0), 0);
  const activeDays = daily.filter(row => row.prompts || row.sessions || row.tools).length;
  const longestDay = daily.reduce((best, row) => ((row.prompts || 0) > (best?.prompts || 0) ? row : best), null);
  const firstDay = daily.find(row => row.prompts || row.sessions || row.tools);

  return [
    { label: 'Messages', value: formatNumber(totalMessages), sub: 'selected range' },
    { label: 'Tool Calls', value: formatNumber(totalTools), sub: 'selected range' },
    { label: 'Sessions', value: formatNumber(totalSessions), sub: 'selected range' },
    { label: 'Active Days', value: formatNumber(activeDays), sub: usage.period || '' },
    { label: 'Peak Day', value: formatNumber(longestDay?.prompts || 0), sub: longestDay?.date || '—' },
    { label: 'First Active', value: firstDay?.date || '—', sub: firstDay ? 'within range' : '' }
  ];
}

async function applyStatsRange() {
  const from = document.getElementById('stats-from')?.value;
  const to = document.getElementById('stats-to')?.value;
  if (!from || !to) {
    showToast('Invalid date range', 'Both start and end dates are required.', 'error');
    return;
  }
  if (from > to) {
    showToast('Invalid date range', 'Start date must be before end date.', 'error');
    return;
  }
  State.statsRange = { from, to };
  setLoading(true);
  await runOperation(
    () => loadCurrentView(),
    'Stats updated',
    `${from} → ${to}`
  );
}

async function resetStatsRange() {
  State.statsRange = defaultStatsRange();
  setLoading(true);
  await runOperation(
    () => loadCurrentView(),
    'Stats reset',
    'Showing last 30 days'
  );
}

async function applyStatsPreset(preset) {
  State.statsRange = statsPresetRange(preset);
  setLoading(true);
  await runOperation(
    () => loadCurrentView(),
    'Stats updated',
    `${State.statsRange.from} → ${State.statsRange.to}`
  );
}

function usageChart(rows) {
  const width = 980;
  const height = 320;
  const left = 56;
  const right = 18;
  const top = 18;
  const bottom = 34;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const max = Math.max(...rows.map(row => Math.max(row.prompts, row.sessions, row.tools, 1)), 1);
  const gridLines = 4;
  const xStep = rows.length > 1 ? innerWidth / (rows.length - 1) : innerWidth;
  const yFor = value => top + innerHeight - ((value / max) * innerHeight);
  const makePath = key => rows.map((row, index) => {
    const x = left + (index * xStep);
    const y = yFor(row[key] || 0);
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
  const promptPath = makePath('prompts');
  const sessionPath = makePath('sessions');
  const toolPath = makePath('tools');
  const areaPath = `${promptPath} L ${left + ((rows.length - 1) * xStep)} ${top + innerHeight} L ${left} ${top + innerHeight} Z`;
  return `
    <div class="line-chart">
      <div class="chart-legend">
        <span><i class="legend-dot prompts"></i>Messages</span>
        <span><i class="legend-dot sessions"></i>Sessions</span>
        <span><i class="legend-dot tools"></i>Tool Calls</span>
      </div>
      <div class="chart-surface">
        <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Total usage over time">
          ${Array.from({ length: gridLines + 1 }, (_, index) => {
            const value = Math.round((max / gridLines) * (gridLines - index));
            const y = top + ((innerHeight / gridLines) * index);
            return `
              <g>
                <line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="var(--panel-border)" stroke-width="1"></line>
                <text x="${left - 10}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${formatNumber(value)}</text>
              </g>
            `;
          }).join('')}
          <path d="${areaPath}" fill="rgba(102, 220, 194, 0.14)"></path>
          <path d="${promptPath}" fill="none" stroke="#66dcc2" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></path>
          <path d="${sessionPath}" fill="none" stroke="#8f62d5" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>
          <path d="${toolPath}" fill="none" stroke="#dd9f68" stroke-width="2" stroke-dasharray="6 6" stroke-linejoin="round" stroke-linecap="round"></path>
          ${rows.map((row, index) => {
            const x = left + (index * xStep);
            const promptY = yFor(row.prompts || 0);
            const sessionY = yFor(row.sessions || 0);
            return `
              <g>
                <circle cx="${x}" cy="${promptY}" r="3.5" fill="#66dcc2"></circle>
                <circle cx="${x}" cy="${sessionY}" r="3" fill="#8f62d5"></circle>
                <text x="${x}" y="${height - 10}" text-anchor="middle" fill="var(--muted)" font-size="11">${row.date.slice(5)}</text>
              </g>
            `;
          }).join('')}
        </svg>
      </div>
      <div class="chart-list">
        ${rows.map(row => `<div class="kv"><span>${escapeHtml(row.date)}</span><strong>${formatNumber(row.prompts)} messages · ${formatNumber(row.sessions)} sessions · ${formatNumber(row.tools)} tools</strong></div>`).join('')}
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
    <div class="session-detail">
      <div class="eyebrow">Session Detail</div>
      <h2>${escapeHtml(detail.session.title || '(untitled session)')}</h2>
      <div class="session-meta">
        <div class="kv"><span>Session</span><strong>${escapeHtml(detail.session.id)}</strong></div>
        <div class="kv"><span>Provider</span><strong>${escapeHtml(detail.session.modelProvider || '—')}</strong></div>
        <div class="kv"><span>Path</span><strong>${escapeHtml(detail.session.cwd || '—')}</strong></div>
        <div class="kv"><span>Updated</span><strong>${escapeHtml(formatDate(detail.session.updatedAt))}</strong></div>
      </div>
      <div class="panel-actions-inline">
        <button class="btn btn-small" onclick='copyResumeCommand(${jsQuote(detail.session.id)})'>Copy resume command</button>
        <button class="btn btn-small" onclick='renameSession(${jsQuote(detail.session.id)})'>Rename</button>
        <button class="ghost" onclick='deleteSession(${jsQuote(detail.session.id)})'>Delete</button>
      </div>
      <div class="chip-row" style="margin:12px 0 16px;">
        ${tools || '<span class="chip">No tool events</span>'}
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
    </div>
  `;
}

function copyResumeCommand(sessionId) {
  const command = `codex resume ${sessionId}`;
  const copyPromise = navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(command)
    : Promise.reject(new Error('Clipboard API unavailable'));
  runOperation(
    () => copyPromise,
    'Resume command copied',
    command,
    'Copy failed'
  ).catch(() => {});
}

async function createSession() {
  const title = window.prompt('Session title', 'New session');
  if (!title) return;
  const cwd = window.prompt('Working directory', State.projectPath || '/Volumes/Projects');
  if (!cwd) return;
  const detail = await runOperation(
    () => API.send('/api/sessions', 'POST', { title, cwd }),
    'Session created',
    title
  );
  State.activeSessionId = detail?.session?.id || null;
  await loadCurrentView();
}

async function renameSession(sessionId) {
  const current = State.sessionDetail?.session?.title || '';
  const next = window.prompt('New session title', current);
  if (!next || next === current) return;
  await runOperation(
    () => API.send(`/api/sessions/${encodeURIComponent(sessionId)}`, 'PUT', { title: next }),
    'Session renamed',
    next
  );
  await loadCurrentView();
}

async function deleteSession(sessionId) {
  if (!window.confirm('Delete this session and its local log file?')) return;
  await runOperation(
    async () => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      return res.json();
    },
    'Session deleted',
    sessionId
  );
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
  await runOperation(
    () => API.send('/api/config', 'PUT', { raw }),
    'Config saved',
    '~/.codex/config.toml'
  );
  await loadCurrentView();
}

async function createMcpServer() {
  const name = window.prompt('MCP server name');
  if (!name) return;
  const command = window.prompt('Command', 'npx');
  if (!command) return;
  const argsText = window.prompt('Args (space-separated)', '') || '';
  const cwd = window.prompt('Working directory (optional)', '') || '';
  await runOperation(
    () => API.send('/api/config/mcp', 'POST', {
      name,
      command,
      args: argsText.split(/\s+/).filter(Boolean),
      cwd: cwd || undefined
    }),
    'MCP server created',
    name
  );
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
  await runOperation(
    () => API.send(`/api/config/mcp/${encodeURIComponent(name)}`, 'PUT', {
      newName,
      command,
      args: argsText.split(/\s+/).filter(Boolean),
      cwd: cwd || undefined
    }),
    'MCP server updated',
    newName
  );
  await loadCurrentView();
}

async function deleteMcpServer(name) {
  if (!window.confirm(`Delete MCP server "${name}"?`)) return;
  await runOperation(
    async () => {
      const res = await fetch(`/api/config/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      return res.json();
    },
    'MCP server deleted',
    name
  );
  await loadCurrentView();
}

async function createConfigProject() {
  const projectPath = window.prompt('Project path');
  if (!projectPath) return;
  const trustLevel = window.prompt('Trust level', 'trusted') || 'trusted';
  await runOperation(
    () => API.send('/api/config/projects', 'POST', { path: projectPath, trustLevel }),
    'Trusted project added',
    projectPath
  );
  await loadCurrentView();
}

async function editConfigProject(projectPath) {
  const project = (State.scan?.global?.config?.projects || []).find(item => item.path === projectPath);
  if (!project) return;
  const trustLevel = window.prompt('Trust level', project.trustLevel || 'trusted') || project.trustLevel || 'trusted';
  await runOperation(
    () => API.send('/api/config/projects', 'PUT', { path: projectPath, trustLevel }),
    'Trusted project updated',
    projectPath
  );
  await loadCurrentView();
}

async function deleteConfigProject(projectPath) {
  if (!window.confirm(`Delete trusted project "${projectPath}"?`)) return;
  await runOperation(
    async () => {
      const res = await fetch('/api/config/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath })
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      return res.json();
    },
    'Trusted project deleted',
    projectPath
  );
  await loadCurrentView();
}

function renderPlugins() {
  const plugins = State.pluginData?.plugins || [];
  const activity = Object.entries(State.toolStats?.toolUsage || {})
    .map(([name, count]) => `<div class="kv"><span>${escapeHtml(name)}</span><strong>${formatNumber(count)}</strong></div>`).join('');

  return `
    <div class="grid two">
      ${panel('Installed Plugins', plugins.length ? `<div class="chart-list plugins-list-scroll">${plugins.map(plugin => `
        <article class="mini-card">
          <strong>${escapeHtml(plugin.displayName || plugin.name)}</strong>
          <p>${escapeHtml(plugin.description || 'No description.')}</p>
          <small>${escapeHtml(plugin.version || 'no version')} · ${plugin.tools} tools · ${plugin.prompts} prompts · ${escapeHtml(plugin.category || 'Custom')}</small>
          <div class="chip-row">
            <button class="btn btn-small" onclick='editPlugin(${jsQuote(plugin.name)})'>Edit</button>
            <button class="ghost" onclick='deletePlugin(${jsQuote(plugin.name)})'>Delete</button>
          </div>
        </article>
      `).join('')}</div>` : '<p class="muted">No plugin manifests detected.</p>', `<button class="btn btn-small" onclick='createPlugin()'>New plugin</button>`)}
      ${panel('Tool Activity', activity ? `<div class="chart-list tool-activity-scroll">${activity}</div>` : '<p class="muted">No recent tool events.</p>')}
    </div>
  `;
}

async function createPlugin() {
  const name = window.prompt('Plugin id/name');
  if (!name) return;
  const displayName = window.prompt('Display name', name) || name;
  const description = window.prompt('Description', '') || '';
  const category = window.prompt('Category', 'Custom') || 'Custom';
  await runOperation(
    () => API.send('/api/plugins', 'POST', {
      name,
      displayName,
      description,
      category,
      capabilities: ['Interactive'],
      defaultPrompt: ['Use this plugin from Codex Map']
    }),
    'Plugin created',
    displayName
  );
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
  await runOperation(
    () => API.send(`/api/plugins/${encodeURIComponent(name)}`, 'PUT', {
      name: newName,
      displayName,
      description,
      category,
      capabilities: ['Interactive'],
      defaultPrompt: ['Use this plugin from Codex Map'],
      version: plugin.version || '0.1.0'
    }),
    'Plugin updated',
    displayName
  );
  await loadCurrentView();
}

async function deletePlugin(name) {
  if (!window.confirm(`Delete plugin "${name}"?`)) return;
  await runOperation(
    async () => {
      const res = await fetch(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      return res.json();
    },
    'Plugin deleted',
    name
  );
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
  await runOperation(
    () => API.send('/api/file', 'PUT', {
      path: State.rawSelectedPath,
      content,
      projectPath: State.mode === 'project' ? State.projectPath : null
    }),
    'File saved',
    State.rawSelectedPath || ''
  );
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
  showToast('Export started', 'JSON download opened', 'success');
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
  showToast('Bundle ready', a.download, 'success');
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
    <p class="muted browser-note">${data.codexOnly ? 'Showing Codex-ready folders in this location.' : 'No Codex-ready folders found here yet. Browse deeper or select a folder manually.'}</p>
    ${data.trustedProjects?.length ? `
      <div class="browser-section">
        <strong>Trusted Projects</strong>
        ${data.trustedProjects.map(dir => `
          <div class="browser-row">
            <button class="browser-item" onclick='chooseBrowserPath(${jsQuote(dir.path)})' title="${escapeHtml(dir.path)}">
              <span>${escapeHtml(dir.name)}</span>
              <span class="status-pill ${escapeHtml(dir.status)}">Trusted</span>
            </button>
            <button class="btn btn-small" onclick='chooseBrowserPath(${jsQuote(dir.path)}, "raw")'>Files</button>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${data.discovered?.length ? `
      <div class="browser-section">
        <strong>Discovered Nested Projects</strong>
        ${data.discovered.map(dir => `
          <div class="browser-row">
            <button class="browser-item" onclick='chooseBrowserPath(${jsQuote(dir.path)})' title="${escapeHtml(dir.path)}">
              <span>${escapeHtml(dir.path.replace(`${State.browserPath}/`, ''))}</span>
              <span class="status-pill ${escapeHtml(dir.status)}">${escapeHtml(dir.status === 'full' ? 'Codex ready' : 'Partial')}</span>
            </button>
            <button class="btn btn-small" onclick='chooseBrowserPath(${jsQuote(dir.path)}, "raw")'>Files</button>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${data.parent ? `<button class="browser-item" onclick='openBrowser(${jsQuote(data.parent)})'>..</button>` : ''}
    ${data.dirs.map(dir => `
      <div class="browser-row">
        <button class="browser-item" onclick='${dir.isProject ? `chooseBrowserPath(${jsQuote(dir.path)})` : `openBrowser(${jsQuote(dir.path)})`}' title="${escapeHtml(dir.path)}">
          <span>${escapeHtml(dir.name)}</span>
          ${dir.isProject ? `<span class="status-pill ${escapeHtml(dir.status)}">${escapeHtml(dir.status === 'full' ? 'Codex ready' : 'Partial')}</span>` : ''}
        </button>
        <button class="btn btn-small" onclick='${dir.isProject ? `chooseBrowserPath(${jsQuote(dir.path)}, "raw")` : `chooseBrowserPath(${jsQuote(dir.path)})`}'>${dir.isProject ? 'Files' : 'Select'}</button>
      </div>
    `).join('')}
  `;
}

async function chooseBrowserPath(projectPath, tab = 'map') {
  await addPinnedProject(projectPath);
  closeBrowser();
  selectProject(projectPath, tab);
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
    await runOperation(
      () => API.send('/api/skills', 'POST', body),
      'Skill created',
      name
    );
  } else if (name === draft.originalName) {
    await runOperation(
      () => API.send(`/api/skills/${encodeURIComponent(draft.originalName)}`, 'PUT', body),
      'Skill updated',
      name
    );
  } else {
    await runOperation(
      () => API.send('/api/skills', 'POST', body),
      'Skill renamed',
      `${draft.originalName} → ${name}`
    );
    const qs = new URLSearchParams({ scope: draft.scope });
    const projectPath = currentSkillProjectPath(draft.scope);
    if (projectPath) qs.set('projectPath', projectPath);
    const res = await fetch(`/api/skills/${encodeURIComponent(draft.originalName)}?${qs.toString()}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
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
  await runOperation(
    async () => {
      const res = await fetch(`/api/skills/${encodeURIComponent(draft.originalName)}?${qs.toString()}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      return res.json();
    },
    'Skill deleted',
    draft.originalName
  );
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
window.applyStatsRange = applyStatsRange;
window.applyStatsPreset = applyStatsPreset;
window.resetStatsRange = resetStatsRange;
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

// src/dashboard/ui/app.js

let _refreshInterval = null
let _projectCwd = null   // populated from /api/status for project-scoped rule creation

// ── Router ────────────────────────────────────────────────────────────────────
const routes = {
  overview: renderOverview,
  queue:    renderQueue,
  history:  renderHistory,
  patterns: renderPatterns,
  rules:    renderRules,
  digest:   renderDigest
}

function navigate() {
  const hash = (location.hash || '#overview').replace('#', '')
  const page = routes[hash] ? hash : 'overview'
  clearInterval(_refreshInterval)
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page)
  })
  routes[page]()
}

window.addEventListener('hashchange', navigate)
window.addEventListener('load', navigate)

// ── API fetch ─────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch('/api' + path, opts)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || res.statusText)
    }
    return res.json()
  } catch (e) {
    document.getElementById('content').innerHTML =
      `<p class="error-msg">Error: ${e.message}</p>`
    throw e
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60)  return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return `${Math.floor(s/86400)}d ago`
}

function fmtTs(ts) {
  const d = new Date(ts)
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth()+1).padStart(2,'0') + '-' +
    String(d.getUTCDate()).padStart(2,'0') + ' ' +
    String(d.getUTCHours()).padStart(2,'0') + ':' +
    String(d.getUTCMinutes()).padStart(2,'0')
}

function decisionBadge(d) {
  const cls = { allow:'allow', deny:'deny', defer:'defer', ask:'ask' }[d] || 'ask'
  return `<span class="badge-${cls}">${d}</span>`
}

function updateQueueBadge(count) {
  const el = document.getElementById('queue-badge')
  if (!el) return
  el.textContent = count
  el.classList.toggle('visible', count > 0)
}

// ── Overview ──────────────────────────────────────────────────────────────────
async function renderOverview() {
  clearInterval(_refreshInterval)
  const [status, recent] = await Promise.all([
    apiFetch('/status'),
    apiFetch('/decisions?limit=10')
  ]).catch(() => [null, null])
  if (!status) return

  updateQueueBadge(status.queue_count)

  const afkLabel  = status.afk ? '● ON'  : '● OFF'
  const afkCls    = status.afk ? 'afk-status-on' : 'afk-status-off'
  const btnLabel  = status.afk ? 'Disable AFK' : 'Enable AFK'
  const t = status.today

  const recentRows = (recent?.items || []).map(i => {
    const icon = i.decision === 'allow' ? '✓' : i.decision === 'deny' ? '✗' : '⏸'
    const cmd = (i.command || i.path || i.tool).slice(0, 50)
    return `<div class="recent-row">
      <span class="recent-icon">${icon}</span>
      <span class="badge-tool">${i.tool}</span>
      <span class="recent-cmd">${cmd}</span>
      <span class="recent-time">${timeAgo(i.ts)}</span>
    </div>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Overview</h2>
    <div class="afk-row">
      <div>
        <div class="muted" style="font-size:10px;text-transform:uppercase;margin-bottom:3px">AFK Mode</div>
        <div class="${afkCls}">${afkLabel}</div>
      </div>
      <button onclick="toggleAfk(${!status.afk})">${btnLabel}</button>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Auto-approved</div>
        <div class="stat-value green">${t.auto_approved}</div>
        <div class="stat-sub">today</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Deferred</div>
        <div class="stat-value red" style="cursor:pointer" onclick="location.hash='#queue'">${status.queue_count}</div>
        <div class="stat-sub">pending review</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Auto-rate</div>
        <div class="stat-value blue">${t.auto_rate}%</div>
        <div class="stat-sub">this session</div>
      </div>
    </div>
    <h3>Recent Decisions</h3>
    <div class="card">${recentRows || '<p class="muted">No decisions yet.</p>'}</div>
  `
}

async function toggleAfk(on) {
  await apiFetch('/afk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on })
  }).catch(() => null)
  renderOverview()
}

// ── Queue ─────────────────────────────────────────────────────────────────────
async function renderQueue() {
  clearInterval(_refreshInterval)
  const items = await apiFetch('/queue').catch(() => null)
  if (!items) return

  updateQueueBadge(items.length)

  if (items.length === 0) {
    document.getElementById('content').innerHTML = `
      <h2>Queue</h2>
      <p class="muted">No pending items.</p>
    `
    return
  }

  const cards = items.map(item => {
    const cmd = item.command || item.path || item.tool
    const ts = fmtTs(item.ts)
    return `<div class="queue-item" id="qi-${item.id}">
      <div class="queue-item-header">
        <span class="badge-tool">${item.tool}</span>
        <span class="muted" style="font-size:11px">${ts}</span>
      </div>
      <div class="queue-item-cmd">${cmd}</div>
      <div class="queue-item-meta">${item.session_id}</div>
      <div class="queue-item-actions">
        <button class="btn-allow" onclick="reviewItem(${item.id},'allow')">✓ Allow</button>
        <button class="btn-deny"  onclick="reviewItem(${item.id},'deny')">✗ Deny</button>
      </div>
    </div>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Queue <span class="muted" style="font-size:14px">${items.length} pending</span></h2>
    <div style="margin-bottom:12px">
      <button onclick="approveAll()">Approve All</button>
    </div>
    <div id="queue-list">${cards}</div>
    <p id="queue-error" class="error-msg" style="display:none"></p>
  `
}

async function reviewItem(id, action) {
  const el = document.getElementById(`qi-${id}`)
  if (el) { el.classList.add('fading'); await new Promise(r => setTimeout(r, 300)) }
  await apiFetch(`/queue/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  }).catch(() => null)
  if (el) el.remove()
  // update badge
  const remaining = document.querySelectorAll('.queue-item').length
  updateQueueBadge(remaining)
  if (remaining === 0) {
    document.getElementById('queue-list').innerHTML = '<p class="muted">No pending items.</p>'
  }
}

async function approveAll() {
  const items = document.querySelectorAll('.queue-item')
  const allBtns = document.querySelectorAll('.queue-item-actions button, button[onclick="approveAll()"]')
  allBtns.forEach(b => b.disabled = true)
  const errEl = document.getElementById('queue-error')
  for (const item of items) {
    const id = item.id.replace('qi-', '')
    try {
      await apiFetch(`/queue/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'allow' })
      })
      item.classList.add('fading')
      await new Promise(r => setTimeout(r, 300))
      item.remove()
      updateQueueBadge(document.querySelectorAll('.queue-item').length)
    } catch (e) {
      errEl.textContent = `Error approving item ${id}: ${e.message}`
      errEl.style.display = 'block'
      allBtns.forEach(b => b.disabled = false)
      return
    }
  }
  document.getElementById('queue-list').innerHTML = '<p class="muted">No pending items.</p>'
  updateQueueBadge(0)
}

// ── History ───────────────────────────────────────────────────────────────────
async function renderHistory() {
  clearInterval(_refreshInterval)
  document.getElementById('content').innerHTML = `
    <h2>History</h2>
    <div class="filter-bar">
      <select id="f-tool" onchange="loadHistory(1)">
        <option value="">All tools</option>
        <option>Bash</option><option>Read</option><option>Write</option>
        <option>Edit</option><option>Glob</option><option>Grep</option>
      </select>
      <select id="f-source" onchange="loadHistory(1)">
        <option value="">All sources</option>
        <option>user</option><option>rule</option>
        <option>prediction</option><option>auto_afk</option><option>auto_defer</option>
      </select>
      <input id="f-date" type="date" onchange="loadHistory(1)" placeholder="Date (UTC)">
      <button onclick="clearFilters()">Clear</button>
    </div>
    <div id="history-table"></div>
    <div class="pagination" id="history-pager"></div>
  `
  await loadHistory(1)
}

let _historyPage = 1
async function loadHistory(page) {
  _historyPage = page
  const tool   = document.getElementById('f-tool')?.value   || ''
  const source = document.getElementById('f-source')?.value || ''
  const date   = document.getElementById('f-date')?.value   || ''
  const params = new URLSearchParams({ page, limit: 50 })
  if (tool)   params.set('tool', tool)
  if (source) params.set('source', source)
  if (date)   params.set('date', date)
  const data = await apiFetch('/decisions?' + params).catch(() => null)
  if (!data) return

  const rows = data.items.map(i => {
    const cmd = (i.command || i.path || '—').slice(0, 40)
    const conf = i.confidence != null ? Math.round(i.confidence * 100) + '%' : '—'
    return `<tr>
      <td class="muted">${fmtTs(i.ts)}</td>
      <td><span class="badge-tool">${i.tool}</span></td>
      <td class="mono">${cmd}</td>
      <td>${decisionBadge(i.decision)}</td>
      <td><span class="badge-source">${i.source}</span></td>
      <td class="muted">${conf}</td>
    </tr>`
  }).join('')

  document.getElementById('history-table').innerHTML = `
    <table>
      <thead><tr><th>Time</th><th>Tool</th><th>Command/Path</th><th>Decision</th><th>Source</th><th>Conf</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No results.</td></tr>'}</tbody>
    </table>
  `
  document.getElementById('history-pager').innerHTML = `
    <button onclick="loadHistory(${page-1})" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
    <span class="muted">Page ${data.page} of ${data.pages}</span>
    <button onclick="loadHistory(${page+1})" ${page >= data.pages ? 'disabled' : ''}>Next →</button>
  `
}

function clearFilters() {
  document.getElementById('f-tool').value   = ''
  document.getElementById('f-source').value = ''
  document.getElementById('f-date').value   = ''
  loadHistory(1)
}

// ── Patterns ──────────────────────────────────────────────────────────────────
async function renderPatterns() {
  clearInterval(_refreshInterval)
  const stats = await apiFetch('/stats').catch(() => null)
  if (!stats) return

  const patternRows = stats.top_patterns.map(p => {
    const pct = Math.round((p.allow_rate || 0) * 100)
    return `<tr>
      <td><span class="badge-tool">${p.tool}</span></td>
      <td class="mono">${p.pattern.slice(0, 50)}</td>
      <td class="muted">${p.total}</td>
      <td>
        <div class="rate-bar">
          <div class="rate-green" style="width:${pct}%"></div>
          <div class="rate-red"   style="width:${100-pct}%"></div>
        </div>
      </td>
      <td class="muted">${pct}%</td>
    </tr>`
  }).join('')

  const sourceRows = Object.entries(stats.by_source).map(([src, count]) => {
    const total = Object.values(stats.by_source).reduce((a,b) => a+b, 0)
    const pct = total > 0 ? Math.round(count / total * 100) : 0
    return `<div class="bar-row">
      <div class="bar-label">${src}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-value">${count}</div>
    </div>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Patterns</h2>
    <h3>Top Patterns (last 90 days)</h3>
    <div class="card" style="margin-bottom:20px">
      <table>
        <thead><tr><th>Tool</th><th>Pattern</th><th>Count</th><th>Approval Rate</th><th></th></tr></thead>
        <tbody>${patternRows || '<tr><td colspan="5" class="muted">No data yet.</td></tr>'}</tbody>
      </table>
    </div>
    <h3>By Source</h3>
    <div class="card">${sourceRows || '<p class="muted">No data yet.</p>'}</div>
  `
}

// ── Rules ─────────────────────────────────────────────────────────────────────
async function renderRules() {
  clearInterval(_refreshInterval)
  const [rules, status] = await Promise.all([
    apiFetch('/rules').catch(() => null),
    apiFetch('/status').catch(() => null)
  ])
  if (!rules) return
  _projectCwd = status?.project_cwd ?? null

  const rows = rules.map(r => {
    const scope = r.project ? r.project.split('/').pop() : 'global'
    const created = fmtTs(r.created_ts)
    return `<tr>
      <td class="muted">${r.priority}</td>
      <td><span class="badge-tool">${r.tool}</span></td>
      <td class="mono">${r.pattern}</td>
      <td>${decisionBadge(r.action)}</td>
      <td>${r.label || '—'}</td>
      <td class="muted">${scope}</td>
      <td class="muted">${created}</td>
      <td><button onclick="deleteRule('${r.id}')">✕</button></td>
    </tr>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Rules</h2>
    <div style="margin-bottom:12px">
      <button onclick="toggleAddForm()">+ Add Rule</button>
    </div>
    <div id="add-rule-form" class="inline-form" style="display:none">
      <div class="form-row">
        <div class="form-field">
          <label>Tool</label>
          <select id="r-tool">
            <option>Bash</option><option>Read</option><option>Write</option>
            <option>Edit</option><option>Glob</option><option>Grep</option><option>*</option>
          </select>
        </div>
        <div class="form-field">
          <label>Pattern</label>
          <input id="r-pattern" placeholder="npm *" style="width:200px">
        </div>
        <div class="form-field">
          <label>Action</label>
          <select id="r-action"><option>allow</option><option>deny</option></select>
        </div>
        <div class="form-field">
          <label>Label</label>
          <input id="r-label" placeholder="optional label" style="width:160px">
        </div>
        <div class="form-field">
          <label>Scope</label>
          <select id="r-scope"><option value="">global</option><option value="cwd">this project</option></select>
        </div>
        <div class="form-field">
          <label>Priority</label>
          <input id="r-priority" type="number" value="0" style="width:70px">
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="saveRule()">Save</button>
        <button onclick="toggleAddForm()">Cancel</button>
      </div>
      <p id="rule-error" class="error-msg" style="display:none"></p>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Pri</th><th>Tool</th><th>Pattern</th><th>Action</th><th>Label</th><th>Scope</th><th>Created</th><th></th></tr></thead>
        <tbody id="rules-tbody">${rows || '<tr><td colspan="8" class="muted">No rules yet.</td></tr>'}</tbody>
      </table>
    </div>
  `
}

function toggleAddForm() {
  const f = document.getElementById('add-rule-form')
  f.style.display = f.style.display === 'none' ? 'block' : 'none'
}

async function saveRule() {
  const tool     = document.getElementById('r-tool').value
  const pattern  = document.getElementById('r-pattern').value.trim()
  const action   = document.getElementById('r-action').value
  const label    = document.getElementById('r-label').value.trim() || undefined
  const scopeVal = document.getElementById('r-scope').value
  const project  = scopeVal === 'cwd' ? (_projectCwd ?? undefined) : undefined
  const priority = Number(document.getElementById('r-priority').value) || 0
  const errEl    = document.getElementById('rule-error')
  errEl.style.display = 'none'
  if (!pattern) { errEl.textContent = 'Pattern is required.'; errEl.style.display = 'block'; return }
  await apiFetch('/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, pattern, action, label, project, priority })
  }).catch(e => { errEl.textContent = e.message; errEl.style.display = 'block' })
  renderRules()
}

async function deleteRule(id) {
  await apiFetch(`/rules/${id}`, { method: 'DELETE' }).catch(() => null)
  renderRules()
}

// ── Digest ────────────────────────────────────────────────────────────────────
async function renderDigest() {
  clearInterval(_refreshInterval)
  document.getElementById('content').innerHTML = `
    <h2>Digest</h2>
    <div id="digest-content"><p class="muted">Loading...</p></div>
  `
  await fetchAndRenderDigest()
  const status = await apiFetch('/status').catch(() => null)
  if (status?.afk) {
    _refreshInterval = setInterval(fetchAndRenderDigest, 30000)
  }
}

async function fetchAndRenderDigest() {
  const data = await apiFetch('/digest').catch(() => null)
  const el = document.getElementById('digest-content')
  if (!el || !data) return
  el.innerHTML = `<pre class="digest-pre">${data.digest}</pre>`
}

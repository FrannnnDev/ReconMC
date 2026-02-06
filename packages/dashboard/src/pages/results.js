import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let refreshInterval = null;
let logRefreshInterval = null;
let currentServerId = null;
let currentServer = null;
let selectedScanIndex = 0;
let showPlayerList = {};
let logsAutoScroll = true;
let currentLogs = [];
let agents = [];

/**
 * Get friendly agent name from ID
 */
function getAgentDisplayName(agentId) {
  const agent = agents.find(a => a.id === agentId);
  if (agent?.name) return agent.name;

  if (agentId?.startsWith('agent-')) {
    const suffix = agentId.slice(6);
    if (/^\d+$/.test(suffix)) {
      return `Agent ${suffix}`;
    }
    return 'agent...';
  }
  return agentId || 'Unknown';
}

/**
 * Format relative time
 */
function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Parse Minecraft text component to plain text
 */
function parseDescription(description) {
  if (description === null || description === undefined) return '';
  if (typeof description === 'string') return description;
  if (typeof description === 'number' || typeof description === 'boolean') return String(description);
  if (typeof description === 'object') {
    if (Array.isArray(description)) return description.map(item => parseDescription(item)).join('');
    let result = '';
    if (description.text) result += description.text;
    if (description.extra && Array.isArray(description.extra)) {
      for (const extra of description.extra) result += parseDescription(extra);
    }
    if (description.translate) {
      result += description.translate;
      if (description.with && Array.isArray(description.with)) {
        const params = description.with.map(w => parseDescription(w)).join(', ');
        if (params) result += ` (${params})`;
      }
    }
    if (description.score?.name) result += description.score.name;
    if (description.selector) result += description.selector;
    if (description.keybind) result += description.keybind;
    if (description.nbt) result += description.nbt;
    return result;
  }
  return '';
}

/**
 * Clean Minecraft formatting codes from strings
 */
function cleanFormatting(text) {
  let cleaned = text.replace(/§./g, '');
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned;
}

const MC_COLORS = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
  'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF',
};

const MC_NAMED_COLORS = {
  'black': '#000000', 'dark_blue': '#0000AA', 'dark_green': '#00AA00',
  'dark_aqua': '#00AAAA', 'dark_red': '#AA0000', 'dark_purple': '#AA00AA',
  'gold': '#FFAA00', 'gray': '#AAAAAA', 'dark_gray': '#555555',
  'blue': '#5555FF', 'green': '#55FF55', 'aqua': '#55FFFF',
  'red': '#FF5555', 'light_purple': '#FF55FF', 'yellow': '#FFFF55',
  'white': '#FFFFFF',
};

const CHAR_SIZES = {
  THIN: "!i|,.".split(""),
  MID: "Ilt'".split(""),
  WIDE: "\"#$%&()*+-/0123456789<=>?@aAbBcCdDeEfFgGhHjJkKLmMnNoOpPqQrRsSTuUvVwWxXyYzZ{}~".split("")
};

function obfuscateText(text) {
  return text.split("").map(char => {
    if (CHAR_SIZES.WIDE.includes(char)) return CHAR_SIZES.WIDE[Math.floor(Math.random() * CHAR_SIZES.WIDE.length)];
    if (CHAR_SIZES.MID.includes(char)) return CHAR_SIZES.MID[Math.floor(Math.random() * CHAR_SIZES.MID.length)];
    if (CHAR_SIZES.THIN.includes(char)) return CHAR_SIZES.THIN[Math.floor(Math.random() * CHAR_SIZES.THIN.length)];
    return char;
  }).join("");
}

let obfuscationInterval = null;
function startObfuscationAnimation() {
  if (obfuscationInterval) return;
  obfuscationInterval = setInterval(() => {
    document.querySelectorAll('.mc-obfuscated').forEach(el => {
      if (!el.isConnected) return;
      const original = el.dataset.original;
      if (original) el.textContent = obfuscateText(decodeURIComponent(original));
    });
  }, 80);
}

function stopObfuscationAnimation() {
  if (obfuscationInterval) {
    clearInterval(obfuscationInterval);
    obfuscationInterval = null;
  }
}

const MC_NAMED_COLOR_CLASSES = {
  'black': 'mc-black', 'dark_blue': 'mc-dark-blue', 'dark_green': 'mc-dark_green',
  'dark_aqua': 'mc-dark_aqua', 'dark_red': 'mc-dark_red', 'dark_purple': 'mc-dark_purple',
  'gold': 'mc-gold', 'gray': 'mc-gray', 'dark_gray': 'mc-dark_gray',
  'blue': 'mc-blue', 'green': 'mc-green', 'aqua': 'mc-aqua',
  'red': 'mc-red', 'light_purple': 'mc-light_purple', 'yellow': 'mc-yellow',
  'white': 'mc-white',
};

const MC_COLOR_CLASSES = {
  '0': 'mc-black', '1': 'mc-dark-blue', '2': 'mc-dark_green', '3': 'mc-dark_aqua',
  '4': 'mc-dark_red', '5': 'mc-dark_purple', '6': 'mc-gold', '7': 'mc-gray',
  '8': 'mc-dark_gray', '9': 'mc-blue', 'a': 'mc-green', 'b': 'mc-aqua',
  'c': 'mc-red', 'd': 'mc-light_purple', 'e': 'mc-yellow', 'f': 'mc-white',
};

function formatJsonTextComponent(component, inheritedStyles = {}) {
  if (!component) return '';
  if (typeof component === 'string') return formatTextWithStyles(component, inheritedStyles);
  if (Array.isArray(component)) return component.map(c => formatJsonTextComponent(c, inheritedStyles)).join('');

  const styles = { ...inheritedStyles };
  if (component.color) {
    const colorClass = MC_NAMED_COLOR_CLASSES[component.color];
    if (colorClass) styles.colorClass = colorClass;
    else styles.color = MC_NAMED_COLORS[component.color] || component.color;
  }
  if (component.bold) styles.bold = true;
  if (component.italic) styles.italic = true;
  if (component.underlined) styles.underline = true;
  if (component.strikethrough) styles.strikethrough = true;
  if (component.obfuscated) styles.obfuscated = true;

  let result = '';
  if (component.text !== undefined) result += formatTextWithStyles(String(component.text), styles);
  if (component.translate) result += formatTextWithStyles(component.translate, styles);
  if (component.extra && Array.isArray(component.extra)) {
    for (const extra of component.extra) result += formatJsonTextComponent(extra, styles);
  }
  return result;
}

function formatTextWithStyles(text, styles) {
  if (!text) return '';
  if (text.includes('§')) {
    const innerHtml = formatSectionCodesOnly(text);
    const cssStyles = [];
    const cssClasses = [];
    if (styles.colorClass) cssClasses.push(styles.colorClass);
    else if (styles.color) cssStyles.push(`color:${styles.color}`);
    if (styles.bold) cssClasses.push('mc-bold');
    if (styles.italic) cssClasses.push('mc-italic');
    if (styles.underline) cssClasses.push('mc-underline');
    if (styles.strikethrough) cssClasses.push('mc-strikethrough');
    if (styles.obfuscated) cssClasses.push('mc-obfuscated');
    if (cssStyles.length > 0 || cssClasses.length > 0) {
      const styleAttr = cssStyles.length > 0 ? ` style="${cssStyles.join(';')}"` : '';
      const classAttr = cssClasses.length > 0 ? ` class="${cssClasses.join(' ')}"` : '';
      return `<span${classAttr}${styleAttr}>${innerHtml}</span>`;
    }
    return innerHtml;
  }

  let escaped = escapeHtml(text).replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
  const cssStyles = [];
  const cssClasses = [];
  const dataAttrs = [];

  if (styles.colorClass) cssClasses.push(styles.colorClass);
  else if (styles.color) cssStyles.push(`color:${styles.color}`);
  if (styles.bold) cssClasses.push('mc-bold');
  if (styles.italic) cssClasses.push('mc-italic');
  if (styles.underline) cssClasses.push('mc-underline');
  if (styles.strikethrough) cssClasses.push('mc-strikethrough');
  if (styles.obfuscated) {
    cssClasses.push('mc-obfuscated');
    dataAttrs.push(`data-original="${encodeURIComponent(text)}"`);
    escaped = obfuscateText(text);
  }

  if (cssStyles.length > 0 || cssClasses.length > 0) {
    const styleAttr = cssStyles.length > 0 ? ` style="${cssStyles.join(';')}"` : '';
    const classAttr = cssClasses.length > 0 ? ` class="${cssClasses.join(' ')}"` : '';
    const dataAttr = dataAttrs.length > 0 ? ` ${dataAttrs.join(' ')}` : '';
    return `<span${classAttr}${styleAttr}${dataAttr}>${escaped}</span>`;
  }
  return escaped;
}

function formatSectionCodesOnly(text) {
  if (!text) return '';
  const result = [];
  let currentClasses = [];
  let currentText = '';
  let isObfuscated = false;

  function flushSpan() {
    if (currentText || currentClasses.length > 0) {
      const classAttr = currentClasses.length > 0 ? ` class="${currentClasses.join(' ')}"` : '';
      let dataAttr = '';
      let displayText;
      if (isObfuscated) {
        dataAttr = ` data-original="${encodeURIComponent(currentText)}"`;
        displayText = obfuscateText(currentText);
      } else {
        displayText = escapeHtml(currentText);
      }
      result.push(`<span${classAttr}${dataAttr}>${displayText}</span>`);
    }
    currentText = '';
    currentClasses = [];
    isObfuscated = false;
  }

  let i = 0;
  while (i < text.length) {
    if (text[i] === '§' && i + 1 < text.length) {
      if (currentText || currentClasses.length > 0) flushSpan();
      const code = text[i + 1].toLowerCase();
      if (MC_COLOR_CLASSES[code]) currentClasses.push(MC_COLOR_CLASSES[code]);
      else if (code === 'l') currentClasses.push('mc-bold');
      else if (code === 'm') currentClasses.push('mc-strikethrough');
      else if (code === 'n') currentClasses.push('mc-underline');
      else if (code === 'o') currentClasses.push('mc-italic');
      else if (code === 'k') { currentClasses.push('mc-obfuscated'); isObfuscated = true; }
      else if (code === 'r') flushSpan();
      i += 2;
      continue;
    }
    if (text[i] === '\n' || (text[i] === '\\' && text[i + 1] === 'n')) {
      currentText += '\n';
      i += (text[i] === '\\') ? 2 : 1;
      continue;
    }
    currentText += text[i];
    i++;
  }
  flushSpan();
  return result.join('').replace(/\n/g, '<br>');
}

function formatMinecraftText(text) {
  if (!text) return '';
  if (typeof text === 'object') return formatJsonTextComponent(text);
  if (typeof text !== 'string') return escapeHtml(String(text));
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try { return formatJsonTextComponent(JSON.parse(trimmed)); } catch (e) {}
  }
  if (text.includes('§')) return formatSectionCodes(text);
  return escapeHtml(text).replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
}

function formatSectionCodes(text) {
  if (!text || typeof text !== 'string') return escapeHtml(String(text || ''));
  const result = [];
  let currentClasses = [];
  let currentDataAttrs = [];
  let currentText = '';
  let isObfuscated = false;

  function flushSpan() {
    if (currentText || currentClasses.length > 0) {
      const classAttr = currentClasses.length > 0 ? ` class="${currentClasses.join(' ')}"` : '';
      let dataAttr = '';
      let displayText;
      if (isObfuscated) {
        dataAttr = ` data-original="${encodeURIComponent(currentText)}"`;
        displayText = obfuscateText(currentText);
      } else {
        displayText = escapeHtml(currentText);
      }
      result.push(`<span${classAttr}${dataAttr}>${displayText}</span>`);
    }
    currentText = '';
    currentClasses = [];
    currentDataAttrs = [];
    isObfuscated = false;
  }

  let i = 0;
  while (i < text.length) {
    if (text[i] === '§' && i + 1 < text.length) {
      if (currentText || currentClasses.length > 0) flushSpan();
      const code = text[i + 1].toLowerCase();
      if (MC_COLOR_CLASSES[code]) currentClasses.push(MC_COLOR_CLASSES[code]);
      else if (code === 'l') currentClasses.push('mc-bold');
      else if (code === 'm') currentClasses.push('mc-strikethrough');
      else if (code === 'n') currentClasses.push('mc-underline');
      else if (code === 'o') currentClasses.push('mc-italic');
      else if (code === 'k') { currentClasses.push('mc-obfuscated'); isObfuscated = true; }
      else if (code === 'r') flushSpan();
      i += 2;
      continue;
    }
    if (text[i] === '\n' || (text[i] === '\\' && text[i + 1] === 'n')) {
      currentText += '\n';
      i += (text[i] === '\\') ? 2 : 1;
      continue;
    }
    currentText += text[i];
    i++;
  }
  flushSpan();
  return result.join('').replace(/\n/g, '<br>');
}

export async function render(container) {
  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <h2>Servers</h2>
      <button class="btn btn-primary" id="refresh-btn">Refresh</button>
    </div>

    <div class="card mb-3">
      <div class="flex flex-between" style="align-items: center;">
        <div class="flex flex-gap">
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="all">All</button>
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="online">Online</button>
          <button class="btn-sm btn-secondary filter-btn" data-filter="offline">Offline</button>
        </div>
        <div id="servers-count" class="text-muted">Loading...</div>
      </div>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Server Address</th>
              <th>IP / Hostname</th>
              <th>Status</th>
              <th>Last Scanned</th>
              <th>Scans</th>
              <th>Mode</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="servers-table"></tbody>
        </table>
      </div>
    </div>
  `;

  // Filter buttons
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.filter;
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('btn-primary'));
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.add('btn-secondary'));
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      loadServers(filter);
    });
  });

  // Set initial active filter
  container.querySelector(`[data-filter="all"]`)?.classList.add('btn-primary');
  container.querySelector(`[data-filter="all"]`)?.classList.remove('btn-secondary');

  document.getElementById('refresh-btn').addEventListener('click', () => loadServers());

  await loadServers();
  refreshInterval = setInterval(() => loadServers(), 5000);
}

export function cleanup() {
  if (refreshInterval) clearInterval(refreshInterval);
  if (logRefreshInterval) clearInterval(logRefreshInterval);
  stopObfuscationAnimation();
  currentServerId = null;
  currentServer = null;
  selectedScanIndex = 0;
  showPlayerList = {};
  currentLogs = [];
  logsAutoScroll = true;
}

async function loadServers(statusFilter = 'all') {
  try {
    const servers = await api.getServers(200);

    const filtered = filterServers(servers, statusFilter);
    const tbody = document.getElementById('servers-table');
    const countEl = document.getElementById('servers-count');

    if (countEl) {
      countEl.textContent = `${filtered.length} servers`;
    }

    if (!tbody) return;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No servers found</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(server => {
      const latestResult = server.latestResult;
      const isOnline = latestResult?.ping?.success;
      const serverMode = latestResult?.ping?.serverMode || latestResult?.serverMode || 'unknown';
      const modeIcon = serverMode === 'online' ? '🟢' : serverMode === 'cracked' ? '🔴' : '🟡';

      const lastScanned = server.lastScannedAt
        ? formatRelativeTime(server.lastScannedAt)
        : 'Never';

      return `
        <tr class="clickable" data-server-id="${server.id}">
          <td>
            <div style="font-weight: 500;">${escapeHtml(server.serverAddress)}</div>
          </td>
          <td>
            <div>${server.resolvedIp || '-'}</div>
            ${server.hostname ? `<div class="text-muted"><small>${escapeHtml(server.hostname)}</small></div>` : ''}
          </td>
          <td>
            ${isOnline
              ? '<span class="badge online">Online</span>'
              : server.scanCount > 0
                ? '<span class="badge offline">Offline</span>'
                : '<span class="badge pending">Pending</span>'
            }
          </td>
          <td>${lastScanned}</td>
          <td>${server.scanCount}</td>
          <td>${isOnline ? `${modeIcon} <span class="badge ${serverMode}">${serverMode}</span>` : '-'}</td>
          <td>
            <button class="btn btn-sm btn-primary view-btn">View History</button>
            <button class="btn btn-sm btn-secondary rescan-btn">Rescan</button>
            <button class="btn btn-sm btn-danger delete-btn">Delete</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('tr');
        showServerHistory(row.dataset.serverId);
      });
    });

    tbody.querySelectorAll('.rescan-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('tr');
        const serverId = row.dataset.serverId;
        try {
          const server = servers.find(s => s.id === serverId);
          if (server) {
            const result = await api.addServers([server.serverAddress]);
            showToast(`Server added to queue: ${result.added} added, ${result.skipped} skipped`, 'success');
          }
        } catch (error) {
          showToast(`Error re-queuing server: ${error.message}`, 'error');
        }
      });
    });

    tbody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const serverId = btn.dataset.deleteId || btn.closest('tr').dataset.serverId;
        if (confirm('Are you sure you want to delete this server and all its scan history?')) {
          try {
            await api.deleteServer(serverId);
            showToast('Server deleted', 'success');
            loadServers(statusFilter);
          } catch (error) {
            showToast(`Error deleting server: ${error.message}`, 'error');
          }
        }
      });
    });
  } catch (error) {
    showToast(`Error loading servers: ${error.message}`, 'error');
  }
}

function filterServers(servers, filter) {
  if (filter === 'all') return servers;
  if (filter === 'online') return servers.filter(s => s.latestResult?.ping?.success);
  if (filter === 'offline') return servers.filter(s => !s.latestResult?.ping?.success && s.scanCount > 0);
  return servers;
}

function showServerHistory(serverId) {
  const mainContainer = document.querySelector('main > .flex-1') || document.body;

  currentServerId = serverId;
  selectedScanIndex = 0;
  showPlayerList = {};
  currentLogs = [];
  logsAutoScroll = true;

  // Get server data
  api.getServer(serverId).then(server => {
    if (!server) {
      showToast('Server not found', 'error');
      return;
    }
    currentServer = server;

    // Load agents for friendly name display
    api.getAgents().then(agentList => {
      agents = agentList;
    }).catch(() => {
      agents = [];
    });

    renderServerHistory(mainContainer);
    startObfuscationAnimation();
  }).catch(error => {
    showToast(`Error loading server: ${error.message}`, 'error');
  });
}

function renderServerHistory(container) {
  const server = currentServer;
  if (!server) return;

  const isOnline = server.latestResult?.ping?.success;
  const serverMode = server.latestResult?.ping?.serverMode || server.latestResult?.serverMode || 'unknown';
  const modeIcon = serverMode === 'online' ? '🟢' : serverMode === 'cracked' ? '🔴' : '🟡';

  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <div>
        <button class="btn btn-secondary" id="back-btn">← Back to Servers</button>
        <h2 style="display: inline; margin-left: 1rem;">${escapeHtml(server.serverAddress)}</h2>
        ${isOnline ? ` <span class="badge online">Online</span>` : server.scanCount > 0 ? ` <span class="badge offline">Offline</span>` : ` <span class="badge pending">Pending</span>`}
        ${isOnline ? ` <span class="badge ${serverMode}">${modeIcon} ${serverMode}</span>` : ''}
      </div>
      <div class="text-muted">
        ${server.scanCount} scan${server.scanCount !== 1 ? 's' : ''} • First seen ${formatRelativeTime(server.firstSeenAt)}
      </div>
    </div>

    <div class="flex flex-gap" style="align-items: flex-start;">
      <div class="card" style="flex: 1; max-width: 400px;">
        <div class="card-header">
          <h3 class="card-title">Scan History</h3>
        </div>
        <div id="scan-history" class="task-list"></div>
      </div>

      <div class="card" style="flex: 2;">
        <div class="card-header flex flex-between">
          <h3 class="card-title">Scan Details</h3>
        </div>
        <div id="scan-detail"></div>
      </div>
    </div>

    <div class="card mt-3">
      <div class="card-header flex flex-between">
        <h3 class="card-title">Agent Logs</h3>
        <div class="flex flex-gap">
          <label class="flex flex-gap" style="align-items: center; font-size: 0.85rem;">
            <input type="checkbox" id="logs-autoscroll" checked>
            Auto-scroll
          </label>
        </div>
      </div>
      <div id="logs-container" class="logs-container"></div>
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => {
    cleanup();
    render(container);
  });

  document.getElementById('logs-autoscroll').addEventListener('change', (e) => {
    logsAutoScroll = e.target.checked;
  });

  // Build scan history
  const scanHistory = server.scanHistory || [];
  const historyList = document.getElementById('scan-history');

  // Combine latest result with history
  const allScans = [...scanHistory];
  if (server.latestResult && (!scanHistory.length || scanHistory[0]?.result !== server.latestResult)) {
    allScans.unshift({
      timestamp: server.lastScannedAt,
      result: server.latestResult,
      errorMessage: null,
    });
  }

  if (allScans.length === 0) {
    historyList.innerHTML = '<p class="text-center text-muted p-3">No scans yet</p>';
  } else {
    historyList.innerHTML = allScans.map((scan, index) => {
      const result = scan.result;
      const isOnline = result?.ping?.success;
      const statusIcon = isOnline ? '✓' : '✗';
      const statusClass = isOnline ? 'online' : 'offline';
      const time = scan.timestamp ? formatRelativeTime(scan.timestamp) : 'Unknown';

      return `
        <div class="task-item${index === selectedScanIndex ? ' active' : ''}" data-index="${index}">
          <div class="task-header">
            <span class="task-address">Scan #${allScans.length - index}</span>
            <span class="badge ${statusClass}">${statusIcon} ${isOnline ? 'Online' : 'Offline'}</span>
          </div>
          <div class="task-meta">
            <span class="task-duration text-muted">
              <small>${time}</small>
            </span>
          </div>
        </div>
      `;
    }).join('');

    historyList.querySelectorAll('.task-item').forEach(item => {
      item.addEventListener('click', () => {
        selectedScanIndex = parseInt(item.dataset.index);
        historyList.querySelectorAll('.task-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        showScanDetail(allScans[selectedScanIndex]);
        loadLogs(allScans[selectedScanIndex]?.errorMessage ? null : allScans[selectedScanIndex]);
      });
    });

    // Show most recent scan
    if (allScans.length > 0) {
      showScanDetail(allScans[0]);
      loadLogs(allScans[0]);
    }
  }

  if (logRefreshInterval) clearInterval(logRefreshInterval);
  logRefreshInterval = setInterval(() => {
    if (currentLogs.length === 0 || !logsAutoScroll) return;
    loadLogs(allScans[selectedScanIndex]);
  }, 5000);
}

function showScanDetail(scan) {
  const detail = document.getElementById('scan-detail');
  if (!detail) return;

  const result = scan.result;
  const errorMessage = scan.errorMessage;

  let html = '';

  if (errorMessage) {
    html += `
      <div class="detail-section error-section">
        <div class="detail-label">Error</div>
        <div class="detail-value text-error">
          <div class="error-message mc-text">${formatMinecraftText(errorMessage)}</div>
        </div>
      </div>
    `;
  }

  const ping = result?.ping;
  const connection = result?.connection;

  if (ping) {
    const data = ping.status?.data;

    if (data?.favicon) {
      html += `
        <div class="detail-section">
          <div class="detail-label">Server Icon</div>
          <div class="detail-value">
            <img src="${data.favicon}" alt="Server Icon" style="width: 64px; height: 64px; image-rendering: pixelated;" />
          </div>
        </div>
      `;
    }

    if (ping.serverMode || result.serverMode) {
      const mode = ping.serverMode || result.serverMode;
      const modeIcon = mode === 'online' ? '🟢' : mode === 'cracked' ? '🔴' : '🟡';
      html += `
        <div class="detail-section">
          <div class="detail-label">Server Mode</div>
          <div class="detail-value">${modeIcon} ${mode.charAt(0).toUpperCase() + mode.slice(1)}</div>
        </div>
      `;
    }

    if (data?.description) {
      const motdHtml = formatMinecraftText(data.description);
      if (motdHtml) {
        html += `
          <div class="detail-section">
            <div class="detail-label">MOTD</div>
            <div class="detail-value motd-display">${motdHtml}</div>
          </div>
        `;
      }
    }

    if (data?.version) {
      html += `
        <div class="detail-section">
          <div class="detail-label">Version</div>
          <div class="detail-value">
            ${data.version.name || 'Unknown'} <span class="text-muted">(protocol ${data.version.protocol || '?'})</span>
          </div>
        </div>
      `;
    }

    if (data?.players) {
      const online = Math.max(0, Number(data.players.online) || 0);
      const max = Math.max(0, Number(data.players.max) || 0);
      const sample = data.players.sample;
      const scanId = `scan-${Date.now()}`;

      html += `
        <div class="detail-section">
          <div class="detail-label">Players</div>
          <div class="detail-value">
            <strong>${online}</strong> / ${max}
            ${sample && sample.length > 0 ? `
              <button class="btn btn-sm btn-secondary ml-2" id="toggle-players-${scanId}">
                ${showPlayerList[scanId] ? 'Hide' : 'Show'} Players (${sample.length})
              </button>
            ` : ''}
          </div>
          ${showPlayerList[scanId] && sample && sample.length > 0 ? `
            <div class="player-list mt-2">
              ${sample.map(p => {
                const name = p.name || p.username || 'Unknown';
                const id = p.id;
                const isValidUUID = id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) && !id.startsWith('00000000');
                const nameMcUrl = isValidUUID ? `https://namemc.com/profile/${id.replace(/-/g, '')}` : `https://namemc.com/search?q=${encodeURIComponent(name)}`;
                return `
                  <div class="player-item">
                    ${isValidUUID ? '✅' : '❌'}
                    <a href="${nameMcUrl}" target="_blank" rel="noopener">${escapeHtml(name)}</a>
                    ${id ? `<code class="uuid-code" title="Click to copy" data-uuid="${escapeHtml(id)}">${escapeHtml(id)}</code>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    if (ping.status?.latency !== null && ping.status?.latency !== undefined) {
      html += `
        <div class="detail-section">
          <div class="detail-label">Latency</div>
          <div class="detail-value">${ping.status.latency}ms</div>
        </div>
      `;
    }

    html += `
      <div class="detail-section">
        <div class="detail-label">Ping Status</div>
        <div class="detail-value">
          ${ping.success ? '<span class="text-success">● Online</span>' : '<span class="text-error">● Offline</span>'}
        </div>
      </div>
    `;
  }

  if (connection) {
    html += `
      <div class="detail-section">
        <div class="detail-label">Connection</div>
        <div class="detail-value">
          ${connection.success ? '<span class="text-success">● Connected</span>' : '<span class="text-error">● Failed</span>'}
        </div>
      </div>
    `;

    if (connection.success) {
      if (connection.username) {
        html += `
          <div class="detail-section">
            <div class="detail-label">Username</div>
            <div class="detail-value">${connection.username}</div>
          </div>
        `;
      }

      if (connection.uuid) {
        html += `
          <div class="detail-section">
            <div class="detail-label">UUID</div>
            <div class="detail-value"><code>${connection.uuid}</code></div>
          </div>
        `;
      }

      if (connection.accountType) {
        const accountLabel = connection.accountType === 'microsoft' ? '🟢 Microsoft' : '🔴 Cracked';
        html += `
          <div class="detail-section">
            <div class="detail-label">Account Type</div>
            <div class="detail-value">${accountLabel}</div>
          </div>
        `;
      }

      if (connection.serverAuth) {
        const auth = connection.serverAuth;
        if (auth.authRequired) {
          const authStatus = auth.success ? '✅ Success' : '❌ Failed';
          const authTypeLabel = auth.authType === 'register' ? 'Registered' : 'Logged In';
          html += `
            <div class="detail-section">
              <div class="detail-label">Server Auth</div>
              <div class="detail-value">${authStatus} (${authTypeLabel})</div>
            </div>
          `;
        } else {
          html += `
            <div class="detail-section">
              <div class="detail-label">Server Auth</div>
              <div class="detail-value">⚪ Not Required</div>
            </div>
          `;
        }
      }

      if (connection.spawnPosition) {
        const pos = connection.spawnPosition;
        html += `
          <div class="detail-section">
            <div class="detail-label">Spawn Position</div>
            <div class="detail-value">X: ${pos.x}, Y: ${pos.y}, Z: ${pos.z}</div>
          </div>
        `;
      }

      if (connection.serverPlugins?.plugins?.length > 0) {
        const plugins = connection.serverPlugins;
        const methodLabel = plugins.method === 'plugins_command' ? '/plugins'
          : plugins.method === 'bukkit_plugins_command' ? 'bukkit:plugins'
          : plugins.method === 'command_tree' ? 'command tree'
          : plugins.method === 'tab_complete' ? 'tab completion'
          : plugins.method === 'combined' ? 'command tree + tab completion'
          : 'unknown';

        html += `
          <div class="detail-section">
            <div class="detail-label">Plugins (${plugins.plugins.length}) - via ${methodLabel}</div>
            <div class="detail-value">
              ${plugins.plugins.map(p => `<span class="badge pending">${p}</span>`).join(' ')}
            </div>
          </div>
        `;
      }

      if (connection.connectedAt) {
        html += `
          <div class="detail-section">
            <div class="detail-label">Connected At</div>
            <div class="detail-value">${new Date(connection.connectedAt).toLocaleString()}</div>
          </div>
        `;
      }
    } else {
      if (connection.error) {
        html += `
          <div class="detail-section">
            <div class="detail-label">Connection Error</div>
            <div class="detail-value text-error">
              <code>${connection.error.code || 'UNKNOWN'}</code>
            </div>
          </div>
        `;
        if (connection.error.kicked && connection.error.kickReason) {
          html += `
            <div class="detail-section">
              <div class="detail-label">Server Message</div>
              <div class="detail-value mc-text">${formatMinecraftText(connection.error.kickReason)}</div>
            </div>
          `;
        } else if (connection.error.message) {
          html += `
            <div class="detail-section">
              <div class="detail-label">Error Message</div>
              <div class="detail-value mc-text">${formatMinecraftText(connection.error.message)}</div>
            </div>
          `;
        }
      }
    }
  }

  if (!ping && !connection && !errorMessage) {
    html += `
      <div class="detail-section">
        <div class="text-muted">No scan result data available</div>
      </div>
    `;
  }

  detail.innerHTML = html;

  // Add event listener for player list toggle
  const toggleBtn = document.getElementById(`toggle-players-${scan.timestamp?.replace(/[^0-9]/g, '') || 'scan-' + Date.now()}`);
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const scanId = toggleBtn.id.replace('toggle-players-', '');
      showPlayerList[scanId] = !showPlayerList[scanId];
      showScanDetail(scan);
    });
  }

  // Copy UUID to clipboard
  detail.querySelectorAll('.uuid-code').forEach(el => {
    el.addEventListener('click', () => {
      const uuid = el.dataset.uuid;
      if (uuid && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(uuid).then(() => showToast('UUID copied to clipboard', 'success'));
      }
    });
  });
}

async function loadLogs(scan) {
  // Since we're using the server history, logs are embedded in the scan result
  // We'll show any error messages or connection details as logs
  const logsContainer = document.getElementById('logs-container');
  if (!logsContainer) return;

  const result = scan.result;
  const logs = [];

  if (scan.errorMessage) {
    logs.push({ level: 'error', message: scan.errorMessage, timestamp: scan.timestamp });
  }

  if (result?.ping) {
    const ping = result.ping;
    logs.push({ level: 'info', message: `Ping: ${ping.success ? 'Success' : 'Failed'} (${ping.status?.latency ?? 'N/A'}ms)`, timestamp: scan.timestamp });
    if (ping.serverMode) {
      logs.push({ level: 'info', message: `Server mode: ${ping.serverMode}`, timestamp: scan.timestamp });
    }
  }

  if (result?.connection) {
    const conn = result.connection;
    logs.push({ level: 'info', message: `Connection: ${conn.success ? 'Success' : 'Failed'}`, timestamp: scan.timestamp });
    if (conn.latency) {
      logs.push({ level: 'info', message: `Latency: ${conn.latency}ms`, timestamp: scan.timestamp });
    }
    if (conn.accountType) {
      logs.push({ level: 'info', message: `Account type: ${conn.accountType}`, timestamp: scan.timestamp });
    }
    if (conn.error) {
      logs.push({ level: 'error', message: `Connection error: ${conn.error.code} - ${conn.error.message}`, timestamp: scan.timestamp });
    }
    if (conn.serverPlugins?.plugins) {
      logs.push({ level: 'info', message: `Plugins found: ${conn.serverPlugins.plugins.length}`, timestamp: scan.timestamp });
    }
  }

  currentLogs = logs.reverse();
  renderLogs(logsContainer, currentLogs);
}

function renderLogs(container, logs) {
  if (!container) return;

  if (logs.length === 0) {
    container.innerHTML = '<div class="text-muted text-center p-3">No logs available for this scan</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    const levelClass = log.level === 'error' ? 'text-error' : log.level === 'warn' ? 'text-warning' : '';
    const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
    return `<div class="log-entry ${levelClass}"><span class="log-time">${time}</span> <span class="log-level">[${log.level.toUpperCase()}]</span> <span class="log-message">${escapeHtml(log.message)}</span></div>`;
  }).join('\n');

  if (logsAutoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

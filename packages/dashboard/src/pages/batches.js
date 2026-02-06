import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let refreshInterval = null;
let statusFilter = 'all';

export async function render(container) {
  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <h2>Scan Queue</h2>
      <button class="btn btn-primary" id="add-servers-btn">+ Add Servers</button>
    </div>

    <div class="card mb-3">
      <div class="flex flex-between" style="align-items: center;">
        <div class="flex flex-gap">
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="all">All</button>
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="pending">Pending</button>
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="processing">Processing</button>
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="completed">Completed</button>
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="failed">Failed</button>
        </div>
        <div id="queue-summary" class="text-muted">Loading...</div>
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
              <th>Agent</th>
              <th>Submitted</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody id="queue-table"></tbody>
        </table>
      </div>
    </div>
  `;

  // Filter buttons
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      statusFilter = btn.dataset.filter;
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('btn-primary'));
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.add('btn-secondary'));
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      loadQueue();
    });
  });

  container.querySelector(`[data-filter="${statusFilter}"]`)?.classList.add('btn-primary');
  container.querySelector(`[data-filter="${statusFilter}"]`)?.classList.remove('btn-secondary');

  document.getElementById('add-servers-btn').addEventListener('click', showAddServersModal);

  await loadQueue();
  refreshInterval = setInterval(loadQueue, 3000);
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function loadQueue() {
  try {
    const [entries, queueStatus] = await Promise.all([
      api.getQueueEntries(statusFilter, 200),
      api.getQueueStatus().catch(() => null),
    ]);

    // Update summary
    if (queueStatus) {
      const summaryEl = document.getElementById('queue-summary');
      if (summaryEl) {
        summaryEl.innerHTML = `
          <span class="badge pending">${queueStatus.pending || 0} pending</span>
          <span class="badge processing">${queueStatus.processing || 0} processing</span>
          <span class="text-muted">| ${queueStatus.totalServers || 0} servers scanned</span>
        `;
      }
    }

    const tbody = document.getElementById('queue-table');
    if (!tbody) return;

    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No queue entries found</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(entry => {
      const statusClass = entry.status || 'pending';
      const statusIcon = entry.status === 'pending' ? '○'
        : entry.status === 'processing' ? '⟳'
          : entry.status === 'completed' ? '✓'
            : entry.status === 'failed' ? '✗' : '○';

      const submittedAt = entry.createdAt ? formatRelativeTime(new Date(entry.createdAt)) : '-';
      const startedAt = entry.startedAt ? formatRelativeTime(new Date(entry.startedAt)) : '-';

      return `
        <tr>
          <td><code>${escapeHtml(entry.serverAddress)}</code></td>
          <td>
            <div>${entry.resolvedIp || '-'}</div>
            ${entry.hostname ? `<div class="text-muted"><small>${escapeHtml(entry.hostname)}</small></div>` : ''}
          </td>
          <td><span class="badge ${statusClass}">${statusIcon} ${entry.status}</span></td>
          <td>${entry.assignedAgentId || '-'}</td>
          <td>${submittedAt}</td>
          <td>${startedAt}</td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    showToast(`Error loading queue: ${error.message}`, 'error');
  }
}

function showAddServersModal() {
  const body = `
    <div class="form-group">
      <label for="servers-list">Servers (one per line)</label>
      <textarea id="servers-list" class="form-control" rows="10" placeholder="mc.hypixel.net&#10;play.server.com:25567&#10;..."></textarea>
      <small class="text-muted">Format: host or host:port (default port is 25565)</small>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-add">Cancel</button>
    <button class="btn btn-primary" id="submit-add">Add Servers</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Add Servers to Queue',
    body,
    footer,
  });

  overlay.querySelector('#cancel-add').addEventListener('click', closeModal);
  overlay.querySelector('#submit-add').addEventListener('click', async () => {
    const serversText = document.getElementById('servers-list').value.trim();

    if (!serversText) {
      showToast('Please enter at least one server', 'error');
      return;
    }

    const servers = serversText
      .split('\n')
      .map(s => s.trim())
      .filter(s => s);

    try {
      const result = await api.addServers(servers);
      closeModal();
      showToast(`Added ${result.added} servers, skipped ${result.skipped} duplicates`, 'success');
      loadQueue();
    } catch (error) {
      showToast(`Error adding servers: ${error.message}`, 'error');
    }
  });
}

function formatRelativeTime(date) {
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Re-use showModal from batches
function showModal({ title, body, footer }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${title}</h3>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">${footer}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => {
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  return { overlay, closeModal };
}

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showModal, showConfirm } from '../components/modal.js';

let refreshInterval = null;

export async function render(container) {
  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <h2>Proxies</h2>
      <div class="flex gap-sm">
        <button class="btn btn-secondary" id="export-proxies-btn">Export JSON</button>
        <button class="btn btn-secondary" id="import-proxies-btn">Import File</button>
        <button class="btn btn-primary" id="add-proxy-btn">+ Add Proxy</button>
      </div>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Host:Port</th>
              <th>Protocol</th>
              <th>Username</th>
              <th>Usage Count</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="proxies-table"></tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('add-proxy-btn').addEventListener('click', showAddProxyModal);
  document.getElementById('import-proxies-btn').addEventListener('click', showImportProxiesModal);
  document.getElementById('export-proxies-btn').addEventListener('click', exportProxies);

  await loadProxies();
  refreshInterval = setInterval(loadProxies, 5000);
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function loadProxies() {
  try {
    const proxies = await api.getProxies();
    const tbody = document.getElementById('proxies-table');

    // Check if tbody exists (page might have been redirected due to auth error)
    if (!tbody) {
      return;
    }

    if (proxies.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted">No proxies. Add one to get started.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = proxies.map(proxy => `
      <tr>
        <td><code>${proxy.host}:${proxy.port}</code></td>
        <td><span class="badge pending">${proxy.protocol || 'socks5'}</span></td>
        <td>${proxy.username || '-'}</td>
        <td>${proxy.currentUsage || 0}</td>
        <td><span class="badge ${proxy.isActive ? 'completed' : 'offline'}">${proxy.isActive ? 'active' : 'inactive'}</span></td>
        <td>
          <button class="btn btn-sm btn-secondary toggle-btn" data-id="${proxy.id}" data-active="${proxy.isActive}">
            ${proxy.isActive ? 'Disable' : 'Enable'}
          </button>
          <button class="btn btn-sm btn-danger delete-btn" data-id="${proxy.id}">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const active = btn.dataset.active === 'true';
        try {
          await api.updateProxy(btn.dataset.id, { isActive: !active });
          showToast(`Proxy ${!active ? 'enabled' : 'disabled'}`, 'success');
          loadProxies();
        } catch (error) {
          showToast(`Error updating proxy: ${error.message}`, 'error');
        }
      });
    });

    tbody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showConfirm('Are you sure you want to delete this proxy?', async () => {
          try {
            await api.deleteProxy(btn.dataset.id);
            showToast('Proxy deleted', 'success');
            loadProxies();
          } catch (error) {
            showToast(`Error deleting proxy: ${error.message}`, 'error');
          }
        });
      });
    });
  } catch (error) {
    showToast(`Error loading proxies: ${error.message}`, 'error');
  }
}

function showAddProxyModal() {
  const body = `
    <div class="form-row">
      <div class="form-group">
        <label for="proxy-host">Host</label>
        <input type="text" id="proxy-host" class="form-control" placeholder="proxy.example.com">
      </div>
      <div class="form-group">
        <label for="proxy-port">Port</label>
        <input type="number" id="proxy-port" class="form-control" placeholder="8080">
      </div>
    </div>
    <div class="form-group">
      <label for="proxy-protocol">Protocol</label>
      <select id="proxy-protocol" class="form-control">
        <option value="socks5">SOCKS5</option>
        <option value="socks4">SOCKS4</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="proxy-username">Username (optional)</label>
        <input type="text" id="proxy-username" class="form-control" placeholder="username">
      </div>
      <div class="form-group">
        <label for="proxy-password">Password (optional)</label>
        <input type="password" id="proxy-password" class="form-control" placeholder="password">
      </div>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-proxy">Cancel</button>
    <button class="btn btn-primary" id="submit-proxy">Add Proxy</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Add Proxy',
    body,
    footer,
  });

  overlay.querySelector('#cancel-proxy').addEventListener('click', closeModal);
  overlay.querySelector('#submit-proxy').addEventListener('click', async () => {
    const host = document.getElementById('proxy-host').value.trim();
    const port = parseInt(document.getElementById('proxy-port').value, 10);
    const protocol = document.getElementById('proxy-protocol').value;
    const username = document.getElementById('proxy-username').value.trim() || undefined;
    const password = document.getElementById('proxy-password').value.trim() || undefined;

    if (!host || !port) {
      showToast('Please enter host and port', 'error');
      return;
    }

    try {
      await api.addProxy({ host, port, protocol, username, password });
      closeModal();
      showToast('Proxy added', 'success');
      loadProxies();
    } catch (error) {
      showToast(`Error adding proxy: ${error.message}`, 'error');
    }
  });
}

function showImportProxiesModal() {
  const body = `
    <div class="form-group">
      <label for="import-proxies-text">Proxies (Webshare format)</label>
      <textarea id="import-proxies-text" class="form-control" placeholder="ip:port:user:pass"></textarea>
      <small class="text-muted">One proxy per line. Format: ip:port:username:password</small>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-import">Cancel</button>
    <button class="btn btn-primary" id="submit-import">Import</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Import Proxies',
    body,
    footer,
  });

  overlay.querySelector('#cancel-import').addEventListener('click', closeModal);
  overlay.querySelector('#submit-import').addEventListener('click', async () => {
    const content = document.getElementById('import-proxies-text').value.trim();

    if (!content) {
      showToast('Please enter proxy data', 'error');
      return;
    }

    try {
      const result = await api.importProxies(content);
      closeModal();
      showToast(`Imported ${result.imported || 0} proxies`, 'success');
      loadProxies();
    } catch (error) {
      showToast(`Error importing proxies: ${error.message}`, 'error');
    }
  });
}

async function exportProxies() {
  try {
    const proxies = await api.exportProxies();
    const dataStr = JSON.stringify(proxies, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconmc-proxies-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${proxies.length} proxies`, 'success');
  } catch (error) {
    showToast(`Error exporting proxies: ${error.message}`, 'error');
  }
}

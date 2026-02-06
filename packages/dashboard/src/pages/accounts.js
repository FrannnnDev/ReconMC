import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showModal, showConfirm } from '../components/modal.js';

let refreshInterval = null;
let isRefreshing = false; // Track if a validation is in progress

export async function render(container) {
  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <h2>Accounts</h2>
      <div class="flex gap-sm">
        <button class="btn btn-secondary" id="export-accounts-btn">Export JSON</button>
        <button class="btn btn-secondary" id="import-accounts-btn">Import JSON</button>
        <button class="btn btn-primary" id="add-account-btn">+ Add Account</button>
      </div>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Username</th>
              <th>Usage</th>
              <th>Active</th>
              <th>Validation</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="accounts-table"></tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('add-account-btn').addEventListener('click', showAddAccountModal);
  document.getElementById('import-accounts-btn').addEventListener('click', showImportAccountsModal);
  document.getElementById('export-accounts-btn').addEventListener('click', exportAccounts);

  await loadAccounts();
  refreshInterval = setInterval(() => {
    // Don't auto-refresh while a validation is in progress
    if (!isRefreshing) {
      loadAccounts();
    }
  }, 5000);
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function loadAccounts() {
  try {
    const accounts = await api.getAccounts();
    const tbody = document.getElementById('accounts-table');

    // Check if tbody exists (page might have been redirected due to auth error)
    if (!tbody) {
      return;
    }

    if (accounts.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted">No accounts. Add one to get started.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = accounts.map(account => {
      const isValid = account.isValid !== false; // Default to true if undefined
      const lastValidated = account.lastValidatedAt
        ? new Date(account.lastValidatedAt).toLocaleDateString()
        : 'never';

      return `
        <tr>
          <td><span class="badge pending">${account.type}</span></td>
          <td>${account.username || '-'}</td>
          <td>${account.currentUsage || 0}/${account.maxConcurrent || 3}</td>
          <td><span class="badge ${account.isActive ? 'completed' : 'offline'}">${account.isActive ? 'active' : 'inactive'}</span></td>
          <td>
            <span class="badge ${isValid ? 'completed' : 'offline'}" title="Last validated: ${lastValidated}">
              ${isValid ? 'Valid' : 'Invalid'}
            </span>
            ${account.type === 'microsoft' ? `
              <button class="btn btn-sm btn-secondary validate-btn" data-id="${account.id}" title="Refresh validation" style="margin-left: 0.5rem">
                ↻
              </button>
            ` : ''}
          </td>
          <td>
            <button class="btn btn-sm btn-secondary toggle-btn" data-id="${account.id}" data-active="${account.isActive}">
              ${account.isActive ? 'Disable' : 'Enable'}
            </button>
            <button class="btn btn-sm btn-danger delete-btn" data-id="${account.id}">Delete</button>
          </td>
        </tr>
      `;
    }).join('');

    // Validate/Refresh button for Microsoft accounts
    tbody.querySelectorAll('.validate-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        // Capture account ID immediately to avoid DOM changes affecting it
        const accountId = btn.dataset.id;
        if (!accountId) return;

        // Prevent concurrent validations
        if (isRefreshing) {
          showToast('Another validation is in progress', 'error');
          return;
        }

        isRefreshing = true;
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = '...';

        try {
          const result = await api.validateAccount(accountId);
          if (result.valid) {
            showToast(`Account validated: ${result.username || 'Success'}${result.refreshed ? ' (tokens refreshed)' : ''}`, 'success');
          } else {
            showToast(`Validation failed: ${result.error || 'Unknown error'}`, 'error');
          }
          await loadAccounts();
        } catch (error) {
          showToast(`Error validating account: ${error.message}`, 'error');
          // Only re-enable if we're still showing the same button
          const currentBtn = document.querySelector(`.validate-btn[data-id="${accountId}"]`);
          if (currentBtn) {
            currentBtn.disabled = false;
            currentBtn.textContent = originalText;
          }
        } finally {
          isRefreshing = false;
        }
      });
    });

    tbody.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const active = btn.dataset.active === 'true';
        try {
          await api.updateAccount(btn.dataset.id, { isActive: !active });
          showToast(`Account ${!active ? 'enabled' : 'disabled'}`, 'success');
          loadAccounts();
        } catch (error) {
          showToast(`Error updating account: ${error.message}`, 'error');
        }
      });
    });

    tbody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showConfirm('Are you sure you want to delete this account?', async () => {
          try {
            await api.deleteAccount(btn.dataset.id);
            showToast('Account deleted', 'success');
            loadAccounts();
          } catch (error) {
            showToast(`Error deleting account: ${error.message}`, 'error');
          }
        });
      });
    });
  } catch (error) {
    showToast(`Error loading accounts: ${error.message}`, 'error');
  }
}

function showAddAccountModal() {
  const body = `
    <div class="form-group">
      <label for="account-type">Account Type</label>
      <select id="account-type" class="form-control">
        <option value="microsoft">Microsoft</option>
        <option value="cracked">Cracked (Offline)</option>
      </select>
    </div>
    <div id="cracked-fields" class="hidden">
      <div class="form-group">
        <label for="cracked-username">Username</label>
        <input type="text" id="cracked-username" class="form-control" placeholder="PlayerName">
      </div>
    </div>
    <div id="microsoft-fields">
      <div class="form-group">
        <label for="microsoft-token">Microsoft Access Token</label>
        <input type="text" id="microsoft-token" class="form-control" placeholder="Access token...">
      </div>
      <div class="form-group">
        <label for="microsoft-username">Username (for display)</label>
        <input type="text" id="microsoft-username" class="form-control" placeholder="PlayerName">
      </div>
      <div class="form-group">
        <label for="microsoft-refresh">Refresh Token (optional)</label>
        <input type="text" id="microsoft-refresh" class="form-control" placeholder="Refresh token...">
      </div>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-account">Cancel</button>
    <button class="btn btn-primary" id="submit-account">Add Account</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Add Account',
    body,
    footer,
  });

  const typeSelect = document.getElementById('account-type');
  const crackedFields = document.getElementById('cracked-fields');
  const microsoftFields = document.getElementById('microsoft-fields');

  typeSelect.addEventListener('change', () => {
    if (typeSelect.value === 'cracked') {
      crackedFields.classList.remove('hidden');
      microsoftFields.classList.add('hidden');
    } else {
      crackedFields.classList.add('hidden');
      microsoftFields.classList.remove('hidden');
    }
  });

  overlay.querySelector('#cancel-account').addEventListener('click', closeModal);
  overlay.querySelector('#submit-account').addEventListener('click', async () => {
    const type = typeSelect.value;

    let data;
    if (type === 'cracked') {
      const username = document.getElementById('cracked-username').value.trim();
      if (!username) {
        showToast('Please enter a username', 'error');
        return;
      }
      data = { type, username };
    } else {
      const accessToken = document.getElementById('microsoft-token').value.trim();
      const refreshToken = document.getElementById('microsoft-refresh').value.trim();
      const username = document.getElementById('microsoft-username').value.trim();
      if (!accessToken) {
        showToast('Please enter an access token', 'error');
        return;
      }
      data = { type, accessToken, refreshToken: refreshToken || undefined, username: username || undefined };
    }

    try {
      await api.addAccount(data);
      closeModal();
      showToast('Account added', 'success');
      loadAccounts();
    } catch (error) {
      showToast(`Error adding account: ${error.message}`, 'error');
    }
  });
}

function showImportAccountsModal() {
  const body = `
    <div class="form-group">
      <label for="import-json">JSON Data</label>
      <textarea id="import-json" class="form-control" placeholder='[
  {
    "type": "offline",
    "username": "Player1"
  }
]'></textarea>
      <small class="text-muted">Paste JSON array of account objects</small>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-import">Cancel</button>
    <button class="btn btn-primary" id="submit-import">Import</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Import Accounts',
    body,
    footer,
  });

  overlay.querySelector('#cancel-import').addEventListener('click', closeModal);
  overlay.querySelector('#submit-import').addEventListener('click', async () => {
    const jsonText = document.getElementById('import-json').value.trim();

    if (!jsonText) {
      showToast('Please enter JSON data', 'error');
      return;
    }

    let accounts;
    try {
      accounts = JSON.parse(jsonText);
      if (!Array.isArray(accounts)) {
        throw new Error('JSON must be an array');
      }
    } catch (e) {
      showToast('Invalid JSON format', 'error');
      return;
    }

    try {
      const result = await api.importAccounts(accounts);
      closeModal();
      showToast(`Imported ${result.imported || 0} accounts`, 'success');
      loadAccounts();
    } catch (error) {
      showToast(`Error importing accounts: ${error.message}`, 'error');
    }
  });
}

async function exportAccounts() {
  try {
    const accounts = await api.exportAccounts();
    const dataStr = JSON.stringify(accounts, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconmc-accounts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${accounts.length} accounts`, 'success');
  } catch (error) {
    showToast(`Error exporting accounts: ${error.message}`, 'error');
  }
}

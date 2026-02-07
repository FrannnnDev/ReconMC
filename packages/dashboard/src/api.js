import { getApiKey } from './auth.js';

// Will be replaced by vite define at build time
const API_BASE = import.meta.env.COORDINATOR_URL || '/api';

async function fetchJSON(url, options = {}) {
  const headers = { ...options.headers };

  // Add API key to all requests
  const apiKey = getApiKey();
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // Handle 401 Unauthorized - API key is invalid
  if (response.status === 401) {
    // Clear invalid API key and redirect to login
    localStorage.removeItem('reconmc_api_key');
    window.location.hash = '/login';
    // Return a rejected promise that won't be caught as a regular error
    return Promise.reject(new Error('Unauthorized - redirecting to login'));
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export const api = {
  // Servers
  getServers: (limit = 100, offset = 0) => fetchJSON(`${API_BASE}/servers?limit=${limit}&offset=${offset}`),

  getServer: (id) => fetchJSON(`${API_BASE}/servers/${id}`),

  addServers: (servers) => fetchJSON(`${API_BASE}/servers/add`, {
    method: 'POST',
    body: JSON.stringify({ servers }),
  }),

  deleteServer: (id) => fetchJSON(`${API_BASE}/servers/${id}`, {
    method: 'DELETE',
  }),

  // Queue
  getQueueStatus: () => fetchJSON(`${API_BASE}/queue`),

  getQueueEntries: (status = 'all', limit = 100, offset = 0) =>
    fetchJSON(`${API_BASE}/queue/entries?status=${status}&limit=${limit}&offset=${offset}`),

  // Task logs (for scan queue items)
  getTaskLogs: (id, limit = 100, offset = 0) => fetchJSON(`${API_BASE}/tasks/${id}/logs?limit=${limit}&offset=${offset}`),

  // Agents
  getAgents: () => fetchJSON(`${API_BASE}/agents`),

  // Accounts
  getAccounts: () => fetchJSON(`${API_BASE}/accounts`),

  addAccount: (data) => fetchJSON(`${API_BASE}/accounts`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  deleteAccount: (id) => fetchJSON(`${API_BASE}/accounts/${id}`, {
    method: 'DELETE',
  }),

  updateAccount: (id, data) => fetchJSON(`${API_BASE}/accounts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),

  importAccounts: (accounts) => fetchJSON(`${API_BASE}/accounts/import`, {
    method: 'POST',
    body: JSON.stringify({ accounts }),
  }),

  validateAccount: (id) => fetchJSON(`${API_BASE}/accounts/${id}/validate`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  exportAccounts: () => fetchJSON(`${API_BASE}/accounts/export`),

  // Proxies
  getProxies: () => fetchJSON(`${API_BASE}/proxies`),

  addProxy: (data) => fetchJSON(`${API_BASE}/proxies`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  deleteProxy: (id) => fetchJSON(`${API_BASE}/proxies/${id}`, {
    method: 'DELETE',
  }),

  updateProxy: (id, data) => fetchJSON(`${API_BASE}/proxies/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),

  importProxies: (content) => fetchJSON(`${API_BASE}/proxies/import`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  }),

  exportProxies: () => fetchJSON(`${API_BASE}/proxies/export`),
};

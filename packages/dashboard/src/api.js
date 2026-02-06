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
  // Batches
  getBatches: () => fetchJSON(`${API_BASE}/batches`),

  getBatch: (id) => fetchJSON(`${API_BASE}/batches/${id}`),

  getBatchResults: (id) => fetchJSON(`${API_BASE}/batches/${id}/results`),

  getTaskLogs: (id, limit = 100, offset = 0) => fetchJSON(`${API_BASE}/tasks/${id}/logs?limit=${limit}&offset=${offset}`),

  getBatchLogs: (id, limit = 100, offset = 0) => fetchJSON(`${API_BASE}/batches/${id}/logs?limit=${limit}&offset=${offset}`),

  createBatch: (servers, name) => fetchJSON(`${API_BASE}/batches`, {
    method: 'POST',
    body: JSON.stringify({ servers, name }),
  }),

  cancelBatch: (id) => fetchJSON(`${API_BASE}/batches/${id}/cancel`, {
    method: 'POST',
  }),

  deleteBatch: (id) => fetchJSON(`${API_BASE}/batches/${id}`, {
    method: 'DELETE',
  }),

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
};

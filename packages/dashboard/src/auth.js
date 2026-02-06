// API Key Storage Keys
const API_KEY_STORAGE_KEY = 'reconmc_api_key';
const AUTH_DISABLED_KEY = 'reconmc_auth_disabled';

// Import API_BASE - will be replaced by vite define at build time
const API_BASE = import.meta.env.COORDINATOR_URL || '/api';

// Cache for auth disabled status
let authDisabledCache = null;
let authCheckPromise = null;

/**
 * Get the stored API key
 */
export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

/**
 * Save the API key to localStorage
 */
export function setApiKey(key) {
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

/**
 * Remove the API key (logout)
 */
export function removeApiKey() {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated() {
  return !!getApiKey();
}

/**
 * Check if auth is disabled on the server
 * Returns true if RECONMC_DISABLE_AUTH=true on the server
 */
export async function isAuthDisabled() {
  // Return cached value if available
  if (authDisabledCache !== null) {
    return authDisabledCache;
  }

  // Reuse existing promise if check is in progress
  if (authCheckPromise) {
    return authCheckPromise;
  }

  // Check server auth status
  authCheckPromise = checkServerAuthStatus()
    .then(disabled => {
      authDisabledCache = disabled;
      localStorage.setItem(AUTH_DISABLED_KEY, JSON.stringify({
        value: disabled,
        timestamp: Date.now()
      }));
      return disabled;
    })
    .finally(() => {
      authCheckPromise = null;
    });

  return authCheckPromise;
}

/**
 * Check the server's auth status endpoint
 */
async function checkServerAuthStatus() {
  try {
    const response = await fetch(`${API_BASE}/auth/status`);
    if (response.ok) {
      const data = await response.json();
      // If authRequired is false, then auth is disabled
      return data.authRequired === false;
    }
  } catch (error) {
    console.warn('Failed to check auth status:', error);
  }
  return false;
}

/**
 * Clear the auth disabled cache (call after login/logout)
 */
export function clearAuthCache() {
  authDisabledCache = null;
  localStorage.removeItem(AUTH_DISABLED_KEY);
}

/**
 * Check if user can access the app (either authenticated or auth disabled)
 */
export async function canAccessApp() {
  const disabled = await isAuthDisabled();
  return disabled || isAuthenticated();
}

/**
 * Validate API key format (basic check)
 */
export function isValidApiKeyFormat(key) {
  return typeof key === 'string' && key.length > 0;
}

/**
 * Get a masked version of the API key for display
 */
export function maskApiKey(key) {
  if (!key || key.length < 8) return '***';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

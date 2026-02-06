import { setApiKey, isValidApiKeyFormat } from '../auth.js';

// Use same API_BASE as auth.js - will be replaced by vite define at build time
const API_BASE = import.meta.env.COORDINATOR_URL || '/api';

export async function render(container) {
  container.innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <div class="login-header">
          <h1>ReconMC</h1>
          <p>Enter your API key to access the dashboard</p>
        </div>
        <form id="loginForm" class="login-form">
          <div class="form-group">
            <label for="apiKey">API Key</label>
            <input
              type="password"
              id="apiKey"
              name="apiKey"
              class="form-control"
              placeholder="Enter your API key"
              autocomplete="current-password"
              required
              autofocus
            >
            <small class="text-muted">The API key is set in your coordinator's RECONMC_API_KEY environment variable</small>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="showKey">
              <span>Show key</span>
            </label>
          </div>
          <button type="submit" class="btn btn-primary btn-block">Sign In</button>
        </form>
        <div id="loginError" class="login-error hidden"></div>
      </div>
    </div>
  `;

  const form = container.querySelector('#loginForm');
  const apiKeyInput = container.querySelector('#apiKey');
  const showKeyCheckbox = container.querySelector('#showKey');
  const errorDiv = container.querySelector('#loginError');

  // Toggle password visibility
  showKeyCheckbox.addEventListener('change', () => {
    apiKeyInput.type = showKeyCheckbox.checked ? 'text' : 'password';
  });

  // Handle form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiKey = apiKeyInput.value.trim();

    if (!isValidApiKeyFormat(apiKey)) {
      showError('Please enter a valid API key');
      return;
    }

    // Set loading state
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Verifying...';
    submitBtn.disabled = true;

    try {
      // Verify API key by fetching health endpoint
      const response = await fetch(`${API_BASE}/health`, {
        headers: {
          'X-API-Key': apiKey
        }
      });

      // Health check doesn't require auth, so let's try a protected endpoint
      // Try fetching agents (requires auth)
      const agentsResponse = await fetch(`${API_BASE}/agents`, {
        headers: {
          'X-API-Key': apiKey
        }
      });

      if (agentsResponse.ok || agentsResponse.status === 401) {
        // If we get 401, the key format is valid but key is wrong
        if (agentsResponse.status === 401) {
          showError('Invalid API key. Please check your RECONMC_API_KEY environment variable.');
          submitBtn.textContent = originalText;
          submitBtn.disabled = false;
          return;
        }

        // Success - save the key and redirect
        setApiKey(apiKey);
        window.location.hash = '/';
        return;
      }

      showError('Failed to verify API key. Please try again.');
    } catch (error) {
      showError('Network error. Please check your connection.');
    } finally {
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

  function showError(message) {
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
    errorDiv.classList.add('visible');
  }

  return {
    cleanup: () => {
      // Cleanup if needed
    }
  };
}

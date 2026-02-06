import { defineConfig, loadEnv } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Load env from root directory (2 levels up from packages/dashboard)
  const rootDir = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, rootDir, '');

  const coordinatorUrl = env.COORDINATOR_URL
    ? `${env.COORDINATOR_URL}/api`
    : '/api';

  console.log('Building dashboard with COORDINATOR_URL:', coordinatorUrl);

  return {
    server: {
      port: 3020,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    define: {
      'import.meta.env.COORDINATOR_URL': JSON.stringify(coordinatorUrl),
    },
  };
});

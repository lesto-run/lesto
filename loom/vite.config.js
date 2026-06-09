import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `appType: 'custom'` because Loom does its own SSR HTML assembly in server.js
// rather than letting Vite serve a static index.html.
export default defineConfig({
  plugins: [react()],
  appType: 'custom',
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth':     'http://localhost:3001',
      '/documents': 'http://localhost:3001',
      '/document': 'http://localhost:3001',
      '/fork':     'http://localhost:3001',
    },
  },
});

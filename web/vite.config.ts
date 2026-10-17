import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: { target: ['es2020', 'safari14'] },
  server: {
    proxy: { '/api': { target: 'http://localhost:8080', ws: true } },
  },
});

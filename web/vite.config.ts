import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5174, strictPort: true },
  build: {
    outDir: process.env.PET_CONTROL_BUILD === '1'
      ? resolve(__dirname, '../pet/dist/control')
      : 'dist',
    emptyOutDir: true,
  },
});

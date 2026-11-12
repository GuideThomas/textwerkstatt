import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { themaName, themaOrdner, themaKopf } from './thema.config.js';

// Das Thema (PLAN-oeffentlich-und-demo.md Phase 3): `@thema` zeigt auf themes/<THEMA>/, dessen public/ wird zu dist/,
// und index.html bekommt seinen Namen und die Zeilen aus kopf.html.
const thema = themaName();
const ordner = themaOrdner();

function themaHtml(): Plugin {
  return {
    name: 'thema-html',
    transformIndexHtml(html) {
      return html.replace('%THEMA%', thema).replace('<!-- %THEMA_KOPF% -->', themaKopf());
    },
  };
}

export default defineConfig({
  plugins: [react(), themaHtml()],
  resolve: {
    alias: { '@thema': ordner },
  },
  publicDir: path.join(ordner, 'public'),
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3006',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});

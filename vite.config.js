import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Root is src/ so dev server routes map cleanly:
  //   /              → src/index.html    (landing)
  //   /auth.html     → src/auth.html     (sign in / sign up)
  //   /dashboard.html→ src/dashboard.html(app)
  root:      'src',
  envDir:    '..',    // .env lives at project root, not inside src/
  envPrefix: 'VITE_',

  build: {
    outDir:      '../dist',   // relative to root (src/), so output goes to project dist/
    assetsDir:   'assets',
    emptyOutDir: true,

    rollupOptions: {
      input: {
        index:     resolve(__dirname, 'src/index.html'),
        auth:      resolve(__dirname, 'src/auth.html'),
        dashboard: resolve(__dirname, 'src/dashboard.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});

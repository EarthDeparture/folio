import { defineConfig } from 'vite';

export default defineConfig({
  // Inject environment variables at build time
  // The 'VITE_' prefix is required — variables without it are excluded
  envPrefix: 'VITE_',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: '/src/index.html',
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});

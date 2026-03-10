import { defineConfig } from 'vite';

export default defineConfig({
  // Inject environment variables at build time
  // The 'VITE_' prefix is required — variables without it are excluded
  envPrefix: 'VITE_',
  build: {
    // Keep the single-file app structure
    rollupOptions: {
      input: {
        main: './src/index.html',
      },
    },
  },
});

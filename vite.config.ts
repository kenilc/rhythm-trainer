import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works under a GitHub Pages
  // project path (/rhythm-trainer/) as well as at a root.
  base: './',
  build: {
    // VexFlow bundles its music fonts (~1 MB); that's expected.
    chunkSizeWarningLimit: 1500,
  },
});

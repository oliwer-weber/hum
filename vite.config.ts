import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Excalidraw loads its fonts at runtime from `window.EXCALIDRAW_ASSET_PATH`.
    // Hum is local-first, so we copy the package's fonts into the served root
    // (`/fonts/...`) and point EXCALIDRAW_ASSET_PATH at "/" (see main.tsx).
    // This keeps the canvas fully offline with no CDN fetches.
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
          dest: '',
        },
      ],
    }),
  ],
})

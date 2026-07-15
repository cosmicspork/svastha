import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // The offline code dictionary under /dict/ is opt-in and multi-MB; it
        // must NOT ride the install-time precache. JSON is already outside
        // globPatterns, and this ignore makes that exclusion explicit and
        // future-proof (dictionary.ts fetches these on demand instead).
        globPatterns: ['**/*.{js,css,html,wasm,woff2,png,svg,ico}'],
        globIgnores: ['**/dict/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'Svastha',
        short_name: 'Svastha',
        description: 'Your health record, in your hands.',
        display: 'standalone',
        start_url: '/',
        theme_color: '#F2F5F1',
        background_color: '#F2F5F1',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
})

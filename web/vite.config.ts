import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// The release version release-please maintains for the whole workspace — the
// web app has no version of its own (package.json stays 0.0.0), so the About
// screen bakes this in at build time.
const APP_VERSION: string = JSON.parse(readFileSync('../.release-please-manifest.json', 'utf8'))['.']

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    svelte(),
    VitePWA({
      // 'prompt' (not 'autoUpdate'): a new build must not swap the running
      // bundle out from under the user silently. main.ts's onNeedRefresh
      // surfaces a notification instead, and the user relaunches on their own
      // terms via UpdateSheet's "Relaunch now".
      registerType: 'prompt',
      // 'injectManifest' (not the default 'generateSW'): the worker needs a
      // hand-written `push`/`notificationclick`/`pushsubscriptionchange`
      // handler (see src/sw.ts) that a fully auto-generated worker can't
      // carry. src/sw.ts owns everything generateSW's `workbox` options used
      // to configure — including reproducing its SKIP_WAITING message
      // listener by hand, since that's normally injected automatically too.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Unchanged from the former `workbox` option below. The offline code
        // dictionary under /dict/ is opt-in and multi-MB; it must NOT ride the
        // install-time precache. JSON is already outside globPatterns, and
        // this ignore makes that exclusion explicit and future-proof
        // (dictionary.ts fetches these on demand instead).
        //
        // changelog.json is excluded for a different reason: it's regenerated
        // fresh on every deploy (see scripts/build-changelog) and must always
        // come from the network — the whole point of UpdateSheet's fetch is
        // to learn what the *newly deployed* bundle contains, and a precached
        // copy would just echo back this same build's own notes.
        globPatterns: ['**/*.{js,css,html,wasm,woff2,png,svg,ico}'],
        globIgnores: ['**/dict/**', '**/changelog.json'],
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

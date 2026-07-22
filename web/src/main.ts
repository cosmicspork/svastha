import '@fontsource/young-serif/400.css'
import '@fontsource/atkinson-hyperlegible/400.css'
import '@fontsource/atkinson-hyperlegible/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import './styles/tokens.css'
import './styles/base.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { notifyAppUpdate } from './lib/notifications'
import { setUpdateHandler } from './lib/pwaUpdate'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Dev has no service worker; `virtual:pwa-register` only resolves under the
// vite-plugin-pwa build, so guard the import to keep `bun run dev` working.
//
// registerType is 'prompt' (vite.config.ts): a waiting update never activates
// on its own. onNeedRefresh fires once a new build has installed and is ready
// to take over, at which point we stash the `updateSW` handle for later (the
// user may not tap the notification for a while) and let the notification
// center surface it rather than swapping the app out from under them.
if (import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    const updateSW = registerSW({
      onNeedRefresh() {
        setUpdateHandler(updateSW)
        void notifyAppUpdate(__APP_VERSION__)
      },
    })
  })
}

export default app

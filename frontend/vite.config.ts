import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // vue-i18n build flags: Composition API only, no devtools in production
  define: {
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  server: {
    // In dev mode the backend runs separately; same-origin /api calls are forwarded to it
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})

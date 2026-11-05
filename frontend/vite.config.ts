import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    // In dev mode the backend runs separately; same-origin /api calls are forwarded to it
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})

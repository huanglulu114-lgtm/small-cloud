import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico'],
      // API diagnostic pages must always reach the server; do not let the
      // offline app shell mask /api/chat?check=1 as an ordinary web page.
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//] },
      manifest: {
        name: '小手机',
        short_name: '小手机',
        description: 'AI聊天助手',
        theme_color: '#EDEDED',
        background_color: '#EDEDED',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ],
  server: {
    port: 3000
  }
});

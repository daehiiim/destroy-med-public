import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// og:image·og:url 은 절대 주소여야 해서, Vercel 빌드면 운영 도메인을 index.html의 %SITE_URL% 자리에 넣는다
const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL
const siteUrl = prod ? `https://${prod}` : ''

// Vite 설정: React, Tailwind v4, '@/...' 경로 별칭, 사이트 주소 치환
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    { name: 'site-url', transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl) },
  ],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8000'
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      // `all` so a file with no test at all still shows as 0% rather than
      // vanishing — an absent row reads as nothing to report.
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      // The locales are data (one exported object of strings each, ~580 lines
      // × 5) and `main.tsx` is the mount call. Counting either would move the
      // percentage without saying anything about what is tested.
      exclude: ['src/test/**', 'src/locales/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
})
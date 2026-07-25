import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    // emptyOutDir wipes dist/ on every build, tracked files included — which is
    // how the //go:embed anchor was lost once already (a0fab46): the build
    // deleted frontend/dist/.gitkeep, `git commit -a` carried the deletion, and
    // every clean checkout after that failed at main.go with "pattern
    // all:frontend/dist: no matching files found". The anchor is restored from
    // public/.gitkeep, which vite copies into dist after the wipe — that empty
    // file is load-bearing, not a stray. Keeping emptyOutDir on is deliberate:
    // turning it off would leave stale hashed assets in dist forever.
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
})

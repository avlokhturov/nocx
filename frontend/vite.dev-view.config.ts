// Dev-only Vite config for looking at the real UI in an ordinary browser —
// `make dev-web`, which starts the backend and passes the two values below in.
// Never used by `wails dev`, `wails build` or the e2e suite.
//
// It shims the two Wails bindings a plain browser cannot get: the WS port and
// the capability token. Without them the frontend's GetWSPort() throws, the
// token falls back to "" and the auth gate refuses the socket, so the app
// renders and connects to nothing. Everything else is inherited from
// vite.config.ts, so what you look at is the shipped build config.
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import base from './vite.config'

const port = Number(process.env.NOCX_WS_PORT ?? '9876')
const token = process.env.NOCX_WS_TOKEN ?? ''
const webPort = Number(process.env.NOCX_WEB_PORT ?? '5173')

const wailsShim: Plugin = {
  name: 'nocx-dev-wails-shim',
  transformIndexHtml() {
    return [
      {
        tag: 'script',
        injectTo: 'head-prepend',
        children: `
          window.go = {
            main: {
              WailsApp: {
                GetWSPort: () => Promise.resolve(${port}),
                GetWSToken: () => Promise.resolve(${JSON.stringify(token)}),
                CheckForUpdate: () => Promise.resolve(null),
                ReportHealthy: () => Promise.resolve(),
                ApplyUpdate: () => Promise.resolve(),
              },
            },
          }
        `,
      },
    ]
  },
}

export default defineConfig(
  // strictPort on purpose: a silent bump to 5174 leaves the tunnel pointing at
  // a port nothing serves, which reads as a broken app rather than a busy port.
  mergeConfig(base, {
    plugins: [wailsShim],
    server: { port: webPort, strictPort: true },
  }),
)

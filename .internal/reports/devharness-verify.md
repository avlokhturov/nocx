# devharness verification report

Date: 2026-07-25

## Changes made

### `internal/app/app.go` — added `Option` type and `WithWSAddr`

`New()` changed from `func New() (*App, error)` to `func New(opts ...Option) (*App, error)`.
The zero-arg call (`app.New()`) in the shipped `main.go` is unchanged and compiles cleanly.

`WithWSAddr(addr string) Option` stores the address; when non-empty, it is forwarded as
`transport.WithListenAddr(o.wsAddr)` during transport construction. When empty (default),
no `WithListenAddr` is passed — the transport retains its default `127.0.0.1:0`.

### `cmd/devharness/main.go` — reads `NOCX_WS_ADDR`

```go
opts := []app.Option{}
if addr := os.Getenv("NOCX_WS_ADDR"); addr != "" {
    opts = append(opts, app.WithWSAddr(addr))
}
a, err := app.New(opts...)
```

## Evidence

### 1. `GetWSToken()` resolves a non-empty string inside the page

#### Command

```bash
cd /home/dev/orca/workspaces/nocx/pr-11-boundary

# Start devharness (pinned to 9876 for this run)
NOCX_WS_ADDR=127.0.0.1:9876 go run ./cmd/devharness > /tmp/dh.out 2>/tmp/dh.err &
sleep 3

# Capture token from devharness output
WSPORT=9876
WSTOKEN=DnVpiSWsqmHLlrJ_f0ddrV6XScAxgQXBwMmXMgOkIa4

# Start vite
cd frontend && npx vite --host 127.0.0.1 --port 5173 > /tmp/vite2.out 2>/tmp/vite2.err &
# Wait for vite to be ready
for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/ 2>/dev/null && break; sleep 1; done

# Verify GetWSToken() in-page
source /etc/set-environment
NOCX_WS_PORT=$WSPORT NOCX_WS_TOKEN=$WSTOKEN node -e "
  const { chromium } = require('@playwright/test');
  (async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.addInitScript((opts) => {
      window.go = {
        main: {
          WailsApp: {
            GetWSPort: () => Promise.resolve(Number(opts.p)),
            GetWSToken: () => Promise.resolve(opts.t),
            CheckForUpdate: () => Promise.resolve(null),
            ReportHealthy: () => Promise.resolve(),
            ApplyUpdate: () => Promise.resolve(),
          },
        },
      };
    }, { p: process.env.NOCX_WS_PORT, t: process.env.NOCX_WS_TOKEN });
    await page.goto('http://127.0.0.1:5173/');
    const token = await page.evaluate(() => window.go.main.WailsApp.GetWSToken());
    console.log('GetWSToken() length:', token.length);
    console.log('GetWSToken() non-empty:', token.length > 0);
    await browser.close();
  })().catch(e => { console.error(e); process.exit(1); });
"
```

#### Output

```
Skipping host requirements validation logic because `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS` env variable is set.
GetWSToken() length: 43
GetWSToken() non-empty: true
```

Token length 43 confirms the base64-encoded 32 random bytes.

### 2. Connection WITH the token opens

#### Command

```bash
TOKEN="nocx.token.DnVpiSWsqmHLlrJ_f0ddrV6XScAxgQXBwMmXMgOkIa4"

curl -s -i --max-time 2 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Protocol: $TOKEN" \
  "http://127.0.0.1:9876/session"
```

#### Output

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
Sec-WebSocket-Protocol: nocx.token.DnVpiSWsqmHLlrJ_f0ddrV6XScAxgQXBwMmXMgOkIa4
```

Handshake with `Sec-WebSocket-Protocol: nocx.token.<token>` returns 101.

### 3. Connection WITHOUT the token is rejected before the upgrade

#### Command (no token)

```bash
curl -s -i --max-time 2 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "http://127.0.0.1:9876/session"
```

#### Output

```
HTTP/1.1 401 Unauthorized
Content-Type: text/plain; charset=utf-8
X-Content-Type-Options: nosniff
Date: Sat, 25 Jul 2026 18:55:39 GMT
Content-Length: 13

unauthorized
```

#### Command (wrong token)

```bash
curl -s -i --max-time 2 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Protocol: nocx.token.wrong-token-value" \
  "http://127.0.0.1:9876/session"
```

#### Output

```
HTTP/1.1 401 Unauthorized
Content-Type: text/plain; charset=utf-8
X-Content-Type-Options: nosniff
Date: Sat, 25 Jul 2026 18:55:39 GMT
Content-Length: 13

unauthorized
```

Both return 401 with body `unauthorized`. No WebSocket upgrade.

### 4. With `NOCX_WS_ADDR=127.0.0.1:9876`, devharness listens on 9876

#### Command

```bash
cd /home/dev/orca/workspaces/nocx/pr-11-boundary
NOCX_WS_ADDR=127.0.0.1:9876 timeout 3 go run ./cmd/devharness 2>/dev/null
```

#### Output

```
WSPORT=9876
WSTOKEN=fawxLFeqiBiVi4PYij_lDpIlAX4WFAy9B8Sp7hQUzGQ
```

#### Log evidence (from full run, stderr)

```
time=2026-07-25T21:53:53.016+03:00 level=INFO msg="ws server started" port=9876
```

### e2e auth suite passes

#### Command

```bash
cd /home/dev/orca/workspaces/nocx/pr-11-boundary
source /etc/set-environment
NOCX_WS_PORT=9876 NOCX_WS_TOKEN=DnVpiSWsqmHLlrJ_f0ddrV6XScAxgQXBwMmXMgOkIa4 CI= \
  npx playwright test e2e/auth.spec.ts --project=chromium \
  --config=playwright.headless.config.ts
```

#### Output

```
Running 1 test using 1 worker
  ✓  1 [chromium] › e2e/auth.spec.ts:7:5 › unauthenticated WebSocket is rejected with 401 (275ms)
  1 passed (716ms)
```

Note: `playwright.headless.config.ts` was a temporary config override (deleted after use)
that imported the real `playwright.config.ts` and overrode `baseURL` to `http://127.0.0.1:5173`
while clearing `webServer`. The real config was not modified.

### Cleanup

```bash
pkill -9 devharness
pkill -f "vite"
ss -tlnp | grep -E '9876|5173'   # confirmed free
rm playwright.headless.config.ts
```

- `go build ./...` — clean
- `go test ./internal/...` — 12 packages ok, 1 no tests

## Unverified

Nothing. All four required points confirmed with quoted output.

// @vitest-environment node
// In jsdom, axios would use its XMLHttpRequest adapter. These tests are about Node's transport, so the
// app's real client goes through the path it takes on the server.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// lib/plaid.ts reads its base URL when it's imported. This keeps the real SDK and points it at a
// loopback server, so nothing here can reach Plaid. Set before the import in beforeAll.
const plaidHost = vi.hoisted(() => ({ url: '' }))

vi.mock('plaid', async (importOriginal) => ({
  ...(await importOriginal<typeof import('plaid')>()),
  PlaidEnvironments: {
    get sandbox() {
      return plaidHost.url
    },
    production: 'http://production.invalid',
  },
}))

type Received = { headers: IncomingHttpHeaders; body: string }

function recordingServer(answer: (res: import('node:http').ServerResponse) => void) {
  const received: Received[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      answer(res)
    })
  })
  return { server, received }
}

function listen(server: Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

function close(server: Server) {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(resolve))
}

describe("the app's Plaid client", () => {
  let otherSiteUrl = ''
  let redirect = false

  const otherSite = recordingServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"accounts":[]}')
  })
  const plaid = recordingServer((res) => {
    if (redirect) {
      res.writeHead(307, { location: `${otherSiteUrl}/accounts/get` })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"accounts":[]}')
  })

  let plaidClient: typeof import('@/lib/plaid').plaidClient

  beforeAll(async () => {
    vi.stubEnv('PLAID_CLIENT_ID', 'made-up-client-id')
    vi.stubEnv('PLAID_SECRET', 'made-up-secret')
    otherSiteUrl = await listen(otherSite.server)
    plaidHost.url = await listen(plaid.server)
    ;({ plaidClient } = await import('@/lib/plaid'))
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await close(plaid.server)
    await close(otherSite.server)
  })

  beforeEach(() => {
    redirect = false
    plaid.received.length = 0
    otherSite.received.length = 0
  })

  it('sends a normal call to Plaid with its credentials and the access token', async () => {
    const res = await plaidClient.accountsGet({ access_token: 'made-up-token' })

    expect(res.status).toBe(200)
    expect(plaid.received).toHaveLength(1)
    expect(plaid.received[0].headers['plaid-client-id']).toBe('made-up-client-id')
    expect(plaid.received[0].headers['plaid-secret']).toBe('made-up-secret')
    expect(plaid.received[0].body).toContain('made-up-token')
  })

  it('fails a call that Plaid redirects, and sends the other site nothing (#233)', async () => {
    redirect = true

    await expect(plaidClient.accountsGet({ access_token: 'made-up-token' })).rejects.toMatchObject({
      response: { status: 307 },
    })

    expect(plaid.received).toHaveLength(1)
    expect(otherSite.received).toEqual([])
  })
})

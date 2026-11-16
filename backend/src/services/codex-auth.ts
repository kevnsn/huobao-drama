/**
 * Codex subscription (ChatGPT plan) access for text models.
 *
 * Reuses the login the Codex CLI stores in $CODEX_HOME/auth.json (default ~/.codex)
 * after `codex login`, and talks to the ChatGPT-hosted Responses endpoint instead of
 * the metered API. No API key is involved.
 *
 * The endpoint differs from api.openai.com in three ways handled by codexFetch:
 * it only streams, it is stateless (store:false), and it rejects sampling parameters.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REFRESH_MARGIN_MS = 5 * 60 * 1000

interface CodexAuthFile {
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
  [key: string]: unknown
}

function authPath() {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
}

function readAuthFile(): CodexAuthFile {
  let raw: string
  try {
    raw = readFileSync(authPath(), 'utf8')
  } catch {
    throw new Error(`Codex login not found at ${authPath()}. Run "codex login" in a terminal and sign in with ChatGPT, then try again.`)
  }
  const auth = JSON.parse(raw) as CodexAuthFile
  if (!auth.tokens?.access_token || !auth.tokens?.refresh_token) {
    throw new Error('Codex is not signed in with a ChatGPT account. Run "codex login" and choose "Sign in with ChatGPT".')
  }
  return auth
}

function tokenExpiresAt(accessToken: string): number {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

let refreshing: Promise<CodexAuthFile> | null = null

/** Exchange the refresh token and write the rotated tokens back so the Codex CLI stays signed in. */
function refreshTokens(): Promise<CodexAuthFile> {
  refreshing ??= (async () => {
    const auth = readAuthFile()
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: auth.tokens!.refresh_token,
        scope: 'openid profile email',
      }),
    })
    if (!resp.ok) {
      throw new Error(`Codex login has expired (token refresh returned ${resp.status}). Run "codex login" again.`)
    }
    const fresh = await resp.json() as { id_token?: string; access_token?: string; refresh_token?: string }
    const next: CodexAuthFile = {
      ...auth,
      tokens: {
        ...auth.tokens,
        ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
        ...(fresh.access_token ? { access_token: fresh.access_token } : {}),
        ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    }
    const tmp = `${authPath()}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(tmp, authPath())
    return next
  })().finally(() => { refreshing = null })
  return refreshing
}

export async function getCodexCredentials(forceRefresh = false) {
  let auth = readAuthFile()
  if (forceRefresh || tokenExpiresAt(auth.tokens!.access_token!) - Date.now() < REFRESH_MARGIN_MS) {
    auth = await refreshTokens()
  }
  return { accessToken: auth.tokens!.access_token!, accountId: auth.tokens!.account_id || '' }
}

/** Collapse the event stream into the single JSON body a non-streaming caller expects. */
async function sseToJson(resp: Response): Promise<Response> {
  const text = await resp.text()
  let failure = ''
  const items: any[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    let event: any
    try { event = JSON.parse(line.slice(6)) } catch { continue }
    if (event?.type === 'response.output_item.done' && event.item) items.push(event.item)
    if (event?.type === 'response.completed' || event?.type === 'response.incomplete') {
      // Generated images only arrive on the per-item events; the final event's output can be empty
      if (!event.response?.output?.length) event.response.output = items
      return new Response(JSON.stringify(event.response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (event?.type === 'response.failed' || event?.type === 'error') {
      failure = event?.response?.error?.message || event?.message || failure
    }
  }
  return new Response(JSON.stringify({ error: { message: failure || 'Codex returned no completed response' } }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const codexFetch: typeof fetch = async (input, init) => {
  let wantsStream = true
  let body = init?.body
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      wantsStream = parsed.stream === true
      parsed.stream = true
      parsed.store = false
      delete parsed.temperature
      delete parsed.top_p
      parsed.include = [...new Set([...(parsed.include || []), 'reasoning.encrypted_content'])]
      body = JSON.stringify(parsed)
    } catch { /* not JSON: pass through untouched */ }
  }

  const send = async (forceRefresh: boolean) => {
    const { accessToken, accountId } = await getCodexCredentials(forceRefresh)
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    if (accountId) headers.set('chatgpt-account-id', accountId)
    headers.set('OpenAI-Beta', 'responses=experimental')
    headers.set('originator', 'codex_cli_rs')
    headers.set('Accept', 'text/event-stream')
    return fetch(input, { ...init, headers, body })
  }

  let resp = await send(false)
  if (resp.status === 401) resp = await send(true)
  if (!resp.ok || wantsStream) return resp
  return sseToJson(resp)
}

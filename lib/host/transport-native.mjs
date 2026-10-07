/**
 * The native HTTP route behind the settings page.
 *
 * Evidence for the request shape (see ADR 0001 §4.5):
 *   - the desktop renderer's document origin is `dsh-app://app`;
 *   - `protocol.handle('dsh-app')` forwards every non-asset path to the harness
 *     HTTP carrier and, inside `forwardWebRequest`, DELETES `origin` and attaches
 *     the harness host cookie;
 *   - therefore "reject when Origin is missing" would kill the desktop path, and
 *     the rule below allows a missing Origin while allowlisting the two browser
 *     origins that can legitimately reach this route.
 *
 * Residual risk (accepted, documented): a local process can still call these
 * three endpoints directly. The blast radius is "change the volume / play a
 * sound in this session"; the plugin does not invent a private token to bypass
 * the carrier's own admission policy.
 */

const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u
const MAX_BODY_BYTES = 8192

/** Whether a request may reach the handler, by Origin. */
export function originAllowed(origin) {
  if (origin === null || origin === undefined || origin === '') return true
  if (origin === 'dsh-app://app') return true
  return LOOPBACK_ORIGIN.test(origin)
}

/** Read a JSON body with a hard size cap. Returns undefined for an unparsable body. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      resolve({ tooLarge: true })
      return
    }
    let size = 0
    let data = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({ tooLarge: true })
        req.destroy?.()
        return
      }
      data += chunk
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(data || '{}')
        finish({ value: parsed })
      } catch {
        finish({ invalid: true })
      }
    })
    req.on('error', () => finish({ invalid: true }))
  })
}

/**
 * Build the `webServer.register` route descriptor.
 *
 * @param handlers - the three operations behind the page.
 * @returns a prefix WebRoute for `/perlica-ding/api`.
 */
export function nativeRoute(handlers) {
  return {
    kind: 'prefix',
    path: '/perlica-ding/api',
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      }

      if (!originAllowed(req.headers?.origin ?? null)) {
        send(403, { error: 'origin not allowed' })
        return
      }

      const path = String(req.url || '').split('?')[0]
      const method = String(req.method || 'GET').toUpperCase()

      try {
        if (method === 'GET' && path === '/perlica-ding/api/state') {
          send(200, await handlers.getState())
          return
        }

        if (method === 'POST' && (path === '/perlica-ding/api/volume' || path === '/perlica-ding/api/preview')) {
          // Forces a CORS preflight for any cross-site caller; this carrier sends
          // no CORS headers, so a cross-site POST never reaches this handler.
          const contentType = String(req.headers?.['content-type'] || '').toLowerCase()
          if (!contentType.includes('application/json')) {
            send(415, { error: 'content-type must be application/json' })
            return
          }
          const body = await readJsonBody(req)
          if (body.tooLarge) {
            send(413, { error: 'request body too large' })
            return
          }
          if (body.invalid) {
            send(400, { error: 'request body must be JSON' })
            return
          }

          if (path.endsWith('/volume')) {
            send(200, await handlers.setVolume(body.value?.volume))
            return
          }
          send(200, await handlers.preview(body.value?.kind))
          return
        }

        send(404, { error: 'not found' })
      } catch (error) {
        // A failed write must never look like success (ADR 0001 §6). Handlers mark
        // caller mistakes with `status` (400/413); everything else is a 500.
        const status = Number.isInteger(error?.status) ? error.status : 500
        send(status, { error: String((error && error.message) || error) })
      }
    },
  }
}

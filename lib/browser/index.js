/**
 * dsh-perlica-ding — client half.
 *
 * Registers one Settings page ("佩丽卡提示音") that lets the user dial the
 * notification volume with a slider and preview every sound kind with a
 * button, so the right level can be found by ear instead of by guessing.
 *
 * The page talks to this package's host half over a loopback HTTP route
 * (`/perlica-ding/api/*`), so previews play through the same system-level
 * audio path the real notifications use.
 *
 * The transport lives in this file on purpose. A DSH plugin package serves
 * exactly one browser bundle (`exports["./client"]`), and a factory's
 * synchronous `require()` resolves only module-table specifiers — seed words,
 * materialized modules, boot-graph rows and registered package factories — so
 * a sibling file is not reachable. A package-local chunk (`require.async`)
 * would be the only alternative, and the installed plugin ecosystem ships
 * single-file bundles with zero such chunks; staying self-contained is both
 * the proven shape here and the smaller PR upstream.
 *
 * `createTransport` is exported so the test suite drives this real file.
 *
 * Bundle format: a classic script registering itself with the DSH client
 * module loader (`window.__ModuleLoader__.load`). No build step, no JSX.
 */
window.__ModuleLoader__.load({
  id: 'dsh-perlica-ding',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var DEFAULT_BASE = '/perlica-ding/api'

    var ROUTE_MISSING_HEAD = '插件后台接口未就绪'
    var ROUTE_MISSING_TAIL = '——请重启 DSH 后重试'

    /**
     * Build one semantic transport error: an `Error` that also carries the
     * `{ code, status, message }` shape the caller switches on.
     *
     * @param {'route-missing'|'http'|'bad-payload'} code - failure class.
     * @param {string} message - user-facing text (already localized).
     * @param {number} [status] - HTTP status when one was observed.
     */
    function failure(code, message, status) {
      var error = new Error(message)
      error.code = code
      if (status !== undefined) error.status = status
      return error
    }

    /** Read and validate the frozen `0..100` volume field out of a payload. */
    function readVolume(payload, where) {
      if (payload === null || typeof payload !== 'object') {
        throw failure('bad-payload', where + ' 返回了无法解析的数据')
      }
      var volume = payload.volume
      if (typeof volume !== 'number' || !Number.isFinite(volume)) {
        throw failure('bad-payload', where + ' 返回的 volume 不是有效数字')
      }
      if (volume < 0 || volume > 100) {
        throw failure('bad-payload', where + ' 返回的 volume 超出 0..100：' + volume)
      }
      return volume
    }

    /**
     * Create the transport used by the settings page. Pure logic: no DOM, no
     * timers, no polling, and no retry loop — one call, one request.
     *
     * @param {{ base?: string, fetchImpl?: Function }} [options]
     * @returns {{ getState: Function, setVolume: Function, preview: Function }}
     */
    function createTransport(options) {
      var opts = options || {}
      var base = typeof opts.base === 'string' && opts.base !== '' ? opts.base : DEFAULT_BASE
      var fetchImpl = typeof opts.fetchImpl === 'function'
        ? opts.fetchImpl
        : (typeof fetch === 'function' ? fetch : null)

      if (fetchImpl === null) {
        throw failure('bad-payload', '当前环境没有可用的 fetch，无法连接插件后台')
      }

      /** One request. Never retries, never polls. */
      function request(path, body) {
        var init = { headers: { 'content-type': 'application/json' } }
        if (body !== undefined) {
          init.method = 'POST'
          init.body = JSON.stringify(body)
        }

        return Promise.resolve()
          .then(function () {
            return fetchImpl(base + path, init)
          })
          .catch(function (cause) {
            if (cause && cause.code) throw cause
            // The request never reached a handler: same user-facing class as a
            // route the host has not registered yet.
            throw failure('route-missing', ROUTE_MISSING_HEAD + ROUTE_MISSING_TAIL)
          })
          .then(function (response) {
            var contentType = ''
            try {
              contentType = (response.headers && response.headers.get('content-type')) || ''
            } catch (ignored) {
              contentType = ''
            }

            // A non-JSON body means the request fell through to the web app's
            // SPA/static handler: the plugin route is not registered.
            if (!contentType.includes('application/json')) {
              throw failure(
                'route-missing',
                ROUTE_MISSING_HEAD + '（HTTP ' + response.status + '）' + ROUTE_MISSING_TAIL,
                response.status,
              )
            }

            return Promise.resolve()
              .then(function () {
                return response.json()
              })
              .catch(function () {
                throw failure('bad-payload', '插件后台返回了无法解析的数据', response.status)
              })
              .then(function (data) {
                if (data === null || typeof data !== 'object') {
                  throw failure('bad-payload', '插件后台返回了无法解析的数据', response.status)
                }
                if (!response.ok) {
                  var serverMessage = typeof data.error === 'string' && data.error !== ''
                    ? data.error
                    : 'HTTP ' + response.status
                  throw failure('http', serverMessage, response.status)
                }
                return data
              })
          })
      }

      return {
        /** GET /state — normalized to the frozen shape, tolerant on optional fields. */
        getState: function () {
          return Promise.resolve()
            .then(function () {
              return request('/state')
            })
            .then(function (data) {
              return {
                volume: readVolume(data, '/state'),
                enabled: data.enabled === true,
                debounceMs: typeof data.debounceMs === 'number' && Number.isFinite(data.debounceMs)
                  ? data.debounceMs
                  : 0,
                persistent: data.persistent === true,
                // Diagnostics only. `persistent` above is the single authority: an
                // unknown tier must never be read as "cannot persist" (ADR §9.6/§9.8
                // expect further tiers to appear).
                kind: typeof data.kind === 'string' && data.kind !== '' ? data.kind : 'none',
                kinds: Array.isArray(data.kinds)
                  ? data.kinds
                    .filter(function (entry) {
                      return entry !== null && typeof entry === 'object'
                        && typeof entry.id === 'string' && typeof entry.label === 'string'
                    })
                    .map(function (entry) {
                      return { id: entry.id, label: entry.label }
                    })
                  : [],
              }
            })
        },

        /**
         * POST /volume — returns the volume the HOST settled on. The server may
         * clamp, so the response is re-validated and its value is authoritative.
         */
        setVolume: function (volume) {
          if (typeof volume !== 'number' || !Number.isFinite(volume)) {
            return Promise.reject(failure('bad-payload', '音量必须是数字'))
          }
          return Promise.resolve()
            .then(function () {
              return request('/volume', { volume: volume })
            })
            .then(function (data) {
              return readVolume(data, '/volume')
            })
        },

        /** POST /preview — returns the kind the host actually played. */
        preview: function (kind) {
          if (typeof kind !== 'string' || kind === '') {
            return Promise.reject(failure('bad-payload', '试听档位无效'))
          }
          return Promise.resolve()
            .then(function () {
              return request('/preview', { kind: kind })
            })
            .then(function (data) {
              if (typeof data.played !== 'string' || data.played === '') {
                throw failure('bad-payload', '/preview 返回的 played 不是有效档位')
              }
              return data.played
            })
        },
      }
    }

    /**
     * One memoized transport for the page. A failed construction is not
     * cached, so the manual retry button can build it again.
     */
    var transportPromise = null
    function loadTransport() {
      if (transportPromise) return transportPromise
      transportPromise = Promise.resolve()
        .then(function () {
          return createTransport()
        })
        .catch(function (error) {
          transportPromise = null
          throw error
        })
      return transportPromise
    }

    /** Human-readable text for a transport failure. */
    function describe(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    var VOLUME_PRESETS = [
      { value: 100, label: '原声' },
      { value: 60, label: '适中' },
      { value: 30, label: '轻声' },
      { value: 0, label: '静音' },
    ]

    /**
     * Last-resort labels for the frozen four kinds, used only when the host
     * state carries no usable `kinds` list.
     */
    var KIND_FALLBACK = [
      { id: 'plan', label: '计划出方案' },
      { id: 'done', label: '任务完成' },
      { id: 'ask', label: '需要你回应' },
      { id: 'fail', label: '出错' },
    ]

    var styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        color: 'var(--dsw-alias-label-primary)',
        maxWidth: '560px',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      },
      title: { fontSize: '14px', fontWeight: 600, margin: 0 },
      hint: {
        fontSize: '12px',
        lineHeight: 1.7,
        color: 'var(--dsw-alias-label-secondary)',
        margin: 0,
      },
      sliderRow: { display: 'flex', alignItems: 'center', gap: '12px' },
      slider: { flex: 1, accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'pointer' },
      volumeBadge: {
        minWidth: '52px',
        textAlign: 'right',
        fontSize: '13px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      button: {
        padding: '7px 14px',
        fontSize: '13px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'inherit',
        cursor: 'pointer',
      },
      buttonBusy: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      presetRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      preset: {
        padding: '4px 10px',
        fontSize: '12px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      presetActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      notice: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)', margin: 0 },
      footer: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', margin: 0 },
    }

    function PerlicaDingSettings() {
      const [status, setStatus] = React.useState('loading')
      const [volume, setVolume] = React.useState(100)
      const [kinds, setKinds] = React.useState(KIND_FALLBACK)
      const [capability, setCapability] = React.useState({ persistent: false, kind: 'none' })
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)

      const saveTimer = React.useRef(null)
      const previewTimer = React.useRef(null)
      const committedRef = React.useRef(100)
      const commitSeq = React.useRef(0)

      React.useEffect(() => {
        let cancelled = false
        setStatus('loading')
        loadTransport()
          .then((transport) => transport.getState())
          .then((state) => {
            if (cancelled) return
            committedRef.current = state.volume
            setVolume(state.volume)
            setKinds(state.kinds.length > 0 ? state.kinds : KIND_FALLBACK)
            setCapability({ persistent: state.persistent, kind: state.kind })
            setNotice('')
            setStatus('ready')
          })
          .catch((error) => {
            if (cancelled) return
            setNotice(describe(error))
            setStatus('error')
          })
        return () => {
          cancelled = true
        }
      }, [reloadKey])

      // Every timer this component owns is released on unmount; there is no
      // polling loop and no interval anywhere in this page.
      React.useEffect(() => () => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        if (previewTimer.current) clearTimeout(previewTimer.current)
      }, [])

      /**
       * Persist a volume. On failure the local value falls back to the last
       * value the host acknowledged — a failed save is never shown as saved.
       */
      const commit = React.useCallback((value) => {
        const seq = ++commitSeq.current
        loadTransport()
          .then((transport) => transport.setVolume(value))
          .then((settled) => {
            // Bookkeeping first: a superseded success still settled on the host, so the
            // rollback target must be the newest acknowledged value. Doing this behind
            // the guard let a later failure roll the slider back to a value that was
            // never stored. Only the visible update yields to the newer edit.
            committedRef.current = settled
            if (seq !== commitSeq.current) return
            setVolume(settled)
            setNotice('')
          })
          .catch((error) => {
            if (seq !== commitSeq.current) return
            setNotice('保存失败：' + describe(error))
            // A newer edit is already queued: rolling back now would yank the slider
            // and then jump it forward again when that save lands. The queued save's
            // own result corrects the display.
            if (saveTimer.current) return
            setVolume(committedRef.current)
          })
      }, [])

      const onSlide = (event) => {
        const value = Number(event.target.value)
        setVolume(value)
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => commit(value), 200)
      }

      const onPreset = (value) => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        setVolume(value)
        commit(value)
      }

      const onPreview = (kind) => {
        setBusy(kind)
        loadTransport()
          .then((transport) => transport.preview(kind))
          .catch((error) => setNotice('试听失败：' + describe(error)))
          .then(() => {
            if (previewTimer.current) clearTimeout(previewTimer.current)
            previewTimer.current = setTimeout(() => setBusy(''), 500)
          })
      }

      const retry = () => {
        setNotice('')
        setReloadKey((n) => n + 1)
      }

      if (status === 'loading') {
        return h('div', { style: styles.page }, h('p', { style: styles.hint }, '正在读取插件状态…'))
      }

      // The host bridge is unreachable: surface the reason with one manual
      // retry button instead of a polling loop.
      if (status === 'error') {
        return h('div', { style: styles.page },
          h('div', { style: styles.card },
            h('h3', { style: styles.title }, '暂时无法连接插件后台'),
            h('p', { style: styles.hint }, notice),
            h('p', { style: styles.hint }, '如果刚刚安装或更新过插件，重启 DSH 后点下面的按钮重试即可。'),
            h('div', { style: styles.buttons },
              h('button', {
                type: 'button',
                onClick: retry,
                style: styles.button,
              }, '重试'),
            ),
          ),
        )
      }

      const persistent = capability.persistent === true

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.title }, '提示音音量'),
          h('div', { style: styles.sliderRow },
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: volume,
              onChange: onSlide,
              style: styles.slider,
              'aria-label': '提示音音量',
            }),
            h('span', { style: styles.volumeBadge }, volume + '%'),
          ),
          h('div', { style: styles.presetRow },
            VOLUME_PRESETS.map((preset) =>
              h('button', {
                key: preset.value,
                type: 'button',
                onClick: () => onPreset(preset.value),
                style: Object.assign(
                  {},
                  styles.preset,
                  volume === preset.value ? styles.presetActive : null,
                ),
              }, preset.label + ' ' + preset.value + '%'),
            ),
          ),
          h('p', { style: styles.hint },
            '拖动滑块调节音量，0% 为完全静音。',
            persistent ? '设置会自动保存并立即生效。' : '当前环境无法持久化，重启后恢复默认。',
          ),
        ),
        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.title }, '试听音效'),
          h('p', { style: styles.hint }, '点一下立即播放，用耳朵确认当前音量是否合适。'),
          h('div', { style: styles.buttons },
            kinds.map((kind) =>
              h('button', {
                key: kind.id,
                type: 'button',
                onClick: () => onPreview(kind.id),
                style: Object.assign(
                  {},
                  styles.button,
                  busy === kind.id ? styles.buttonBusy : null,
                ),
              }, busy === kind.id ? '播放中…' : kind.label),
            ),
          ),
        ),
        notice ? h('p', { style: styles.notice }, notice) : null,
        h('p', { style: styles.footer }, '佩丽卡终端 · DeepSeek Harness 分级提示音插件'),
      )
    }

    /** Register the settings page; `inject` scopes ctx.slots availability. */
    function apply(ctx) {
      const slots = ctx.slots || ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'perlica-ding',
            order: 60,
            label: '佩丽卡提示音',
          },
          PerlicaDingSettings,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.PerlicaDingSettings = PerlicaDingSettings
    exports.createTransport = createTransport
    exports.loadTransport = loadTransport
    return module.exports
  },
})

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

    var API = '/perlica-ding/api'

    /** JSON helper over the host bridge. */
    async function request(path, body) {
      const options = { headers: { 'content-type': 'application/json' } }
      if (body !== undefined) {
        options.method = 'POST'
        options.body = JSON.stringify(body)
      }
      const response = await fetch(API + path, options)
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        // The route is missing, so the request fell through to the web app's
        // SPA/static handler (HTML on GET, 405 on POST).
        throw new Error('插件后台接口未就绪（HTTP ' + response.status + '）——请重启 DSH 后再试')
      }
      let data = null
      try {
        data = await response.json()
      } catch (error) {
        data = null
      }
      if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
      if (data === null) throw new Error('插件后台返回了无法解析的数据')
      return data
    }

    const VOLUME_PRESETS = [
      { value: 100, label: '原声' },
      { value: 60, label: '适中' },
      { value: 30, label: '轻声' },
      { value: 0, label: '静音' },
    ]

    const styles = {
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
      const [loading, setLoading] = React.useState(true)
      const [volume, setVolume] = React.useState(100)
      const [kinds, setKinds] = React.useState([])
      const [persistent, setPersistent] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const saveTimer = React.useRef(null)
      const retryTimer = React.useRef(null)

      React.useEffect(() => {
        let cancelled = false
        setLoading(true)
        request('/state')
          .then((state) => {
            if (cancelled) return
            if (!state || typeof state.volume !== 'number') {
              throw new Error('状态数据格式异常')
            }
            setVolume(state.volume)
            setKinds(Array.isArray(state.kinds) ? state.kinds : [])
            setPersistent(state.persistent !== false)
            setNotice('')
            setLoading(false)
          })
          .catch((error) => {
            if (cancelled) return
            setNotice('无法读取插件状态：' + error.message)
            setLoading(false)
            // The host route may register a moment after this page mounts
            // (plugin boot ordering): retry a few times before giving up.
            if (reloadKey < 5) {
              retryTimer.current = setTimeout(() => {
                if (!cancelled) setReloadKey((n) => n + 1)
              }, 2000)
            }
          })
        return () => {
          cancelled = true
          if (saveTimer.current) clearTimeout(saveTimer.current)
          if (retryTimer.current) clearTimeout(retryTimer.current)
        }
      }, [reloadKey])

      const commit = (value) => {
        request('/volume', { volume: value })
          .then((result) => {
            setVolume(result.volume)
            setNotice('')
          })
          .catch((error) => setNotice('保存失败：' + error.message))
      }

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
        request('/preview', { kind })
          .catch((error) => setNotice('试听失败：' + error.message))
          .finally(() => setTimeout(() => setBusy(''), 500))
      }

      if (loading) {
        return h('div', { style: styles.page }, h('p', { style: styles.hint }, '正在读取插件状态…'))
      }

      // The host bridge is unreachable: surface the reason with a retry button
      // instead of rendering a broken panel.
      if (kinds.length === 0 && notice) {
        return h('div', { style: styles.page },
          h('div', { style: styles.card },
            h('h3', { style: styles.title }, '暂时无法连接插件后台'),
            h('p', { style: styles.hint }, notice),
            h('p', { style: styles.hint }, '如果刚刚安装或更新过插件，重启 DSH 后点下面的按钮重试即可。'),
            h('div', { style: styles.buttons },
              h('button', {
                type: 'button',
                onClick: () => { setNotice(''); setReloadKey((n) => n + 1) },
                style: styles.button,
              }, '重试'),
            ),
          ),
        )
      }

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
    return module.exports
  },
})

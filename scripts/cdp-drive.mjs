/**
 * cdp-drive.mjs — drive a CDP page target via WebSocket (no Playwright).
 * Usage:
 *   node cdp-drive.mjs <port> <url-substr> <command> [args...]
 * Commands:
 *   list                      list targets
 *   eval <js>                 evaluate in the target's main frame
 *   frame-eval <js>           evaluate in the first child frame (webview content)
 *   frames                    list frame tree of the target
 *   shot <path.png>           capture screenshot of the target
 */
import WebSocket from 'ws'

const [port, sub, command, ...rest] = process.argv.slice(2)
if (!port || !command) {
  console.error('usage: node cdp-drive.mjs <port> <urlsubstr> <cmd> [args]')
  process.exit(1)
}

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())

if (command === 'list') {
  for (const t of targets) console.log(`${t.type} | ${t.title} | ${String(t.url).slice(0, 140)}`)
  process.exit(0)
}

let target = null
if (sub) {
  const allowSw = sub.includes('service-worker')
  target = targets.find((t) => t.url && t.url.includes(sub) && (allowSw || t.type !== 'service_worker'))
} else {
  target = targets.find((t) => t.type === 'page')
}
if (!target) {
  console.error(`no target containing "${sub}"`)
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const contextList = [] // {id, name, origin}

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.executionContextCreated') {
    const ctx = msg.params.context
    if (!contextList.some((c) => c.id === ctx.id)) {
      contextList.push({ id: ctx.id, name: ctx.name ?? '', origin: String(ctx.origin ?? '') })
    }
  }
})

ws.on('error', (err) => { console.error('ws error', err.message); process.exit(1) })

function collectFrames(node, out = []) {
  out.push({ frameId: node.frame.id, url: node.frame.url, parentId: node.parentId ?? null })
  for (const child of node.childFrames ?? []) collectFrames(child, out)
  return out
}

ws.on('open', async () => {
  try {
    if (command === 'frames') {
      await send('Runtime.enable')
      await send('Page.enable')
      await new Promise((r) => setTimeout(r, 500))
      const tree = await send('Page.getFrameTree')
      for (const f of collectFrames(tree.frameTree)) {
        console.log(`${f.parentId === null ? 'MAIN' : 'child '} ${f.frameId} :: ${f.url.slice(0, 140)}`)
      }
      process.exit(0)
    }

    const evaluate = async (expression, contextId) => {
      const result = await send('Runtime.evaluate', {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      })
      if (result.exceptionDetails) {
        console.error('EXCEPTION: ' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
        process.exit(2)
      }
      const value = result.result?.value
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      process.exit(0)
    }

    if (command === 'eval') {
      await send('Runtime.enable')
      return evaluate(rest.join(' '))
    }

    if (command === 'reload-watch') {
      // Enable Runtime, reload the page, and report JS exceptions/console errors.
      const errors = []
      const origHandler = ws.listeners('message')[0]
      ws.removeListener('message', origHandler)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.method === 'Runtime.exceptionThrown') {
          errors.push('EX: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? ''))
        }
        if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
          const args = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
          errors.push(`${msg.params.type.toUpperCase()}: ${args}`)
        }
        origHandler(data)
      })
      await send('Runtime.enable')
      await send('Page.enable')
      await send('Page.reload', { ignoreCache: true })
      await new Promise((r) => setTimeout(r, 4000))
      console.log(JSON.stringify(errors, null, 1))
      process.exit(0)
    }

    if (command === 'logs') {
      const entries = []
      const origHandler = ws.listeners('message')[0]
      ws.removeListener('message', origHandler)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.method === 'Log.entryAdded') {
          entries.push({ level: msg.params.entry.level, source: msg.params.entry.source, text: msg.params.entry.text.slice(0, 300) })
        }
        origHandler(data)
      })
      await send('Log.enable')
      await new Promise((r) => setTimeout(r, 1500))
      console.log(JSON.stringify(entries, null, 1))
      process.exit(0)
    }

    if (command === 'eval-all') {
      await send('Runtime.enable')
      await new Promise((r) => setTimeout(r, 700))
      const expression = rest.join(' ')
      const results = []
      for (const ctx of contextList) {
        const res = await send('Runtime.evaluate', { expression, contextId: ctx.id, returnByValue: true, awaitPromise: true })
        if (res.exceptionDetails) {
          results.push({ ctxId: ctx.id, error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text })
          continue
        }
        const value = res.result?.value
        results.push({ ctxId: ctx.id, value: typeof value === 'string' ? value : JSON.stringify(value) })
      }
      console.log(JSON.stringify(results, null, 1))
      process.exit(0)
    }

    if (command === 'ctxs') {
      const raw = []
      const origHandler = ws.listeners('message')[0]
      ws.removeListener('message', origHandler)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.method === 'Runtime.executionContextCreated') raw.push(msg.params.context)
        origHandler(data)
      })
      await send('Runtime.enable')
      await new Promise((r) => setTimeout(r, 1200))
      console.log(JSON.stringify(raw.map((c) => ({
        id: c.id,
        name: c.name,
        origin: String(c.origin).slice(0, 80),
        aux: c.auxiliaryData ? { frameId: c.auxiliaryData.frameId, isDefault: c.auxiliaryData.isDefault, type: c.auxiliaryData.type } : null,
      })), null, 1))
      process.exit(0)
    }

    if (command === 'frame-eval') {
      await send('Runtime.enable')
      await new Promise((r) => setTimeout(r, 700))
      const candidates = contextList.filter((c) => c.origin.includes('vscode-webview'))
      if (candidates.length === 0) {
        console.error('no webview-origin context found')
        process.exit(1)
      }
      // Evaluate in every webview-origin context and return the first non-empty result.
      const expression = rest.join(' ')
      for (const ctx of candidates) {
        const res = await send('Runtime.evaluate', { expression, contextId: ctx.id, returnByValue: true, awaitPromise: true })
        if (res.exceptionDetails) continue
        const value = res.result?.value
        if (value !== undefined && value !== null && value !== '' && !(typeof value === 'object' && Object.keys(value).length === 0)) {
          console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
          process.exit(0)
        }
      }
      console.error('all webview contexts returned empty')
      process.exit(1)
    }

    if (command === 'shot') {
      await send('Page.enable')
      const pngPath = rest[0] ?? 'shot.png'
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('fs')
      writeFileSync(pngPath, Buffer.from(shot.data, 'base64'))
      console.log('saved ' + pngPath)
      process.exit(0)
    }
    console.error('unknown command ' + command)
    process.exit(1)
  } catch (err) {
    console.error('ERR: ' + err.message)
    process.exit(1)
  }
})

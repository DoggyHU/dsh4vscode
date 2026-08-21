/* DSH Chat webview logic (vanilla JS) — multi-session tabs. */
(() => {
  'use strict'
  const vscode = acquireVsCodeApi()

  /** @type {{turnId:number, el:HTMLElement, items:Map<string,HTMLElement>}[]} */
  const turns = []
  const chatEl = document.getElementById('chat')
  const emptyHint = document.getElementById('empty-hint')
  const scrollEl = document.getElementById('chat-scroll')
  const inputEl = document.getElementById('input')
  const sendBtn = document.getElementById('btn-send')
  const cancelBtn = document.getElementById('btn-cancel')
  const modelSelect = document.getElementById('model-select')
  const connDot = document.getElementById('conn-dot')
  const connText = document.getElementById('conn-text')
  const sessionBar = document.getElementById('session-bar')
  const statusText = document.getElementById('status-text')
  const toastEl = document.getElementById('toast')
  const tabList = document.getElementById('tab-list')
  const historyPop = document.getElementById('history-pop')
  const historyList = document.getElementById('history-list')
  const btnHistory = document.getElementById('btn-history')
  const questionBanner = document.getElementById('question-banner')
  const questionBody = document.getElementById('question-body')
  const approvalBanner = document.getElementById('approval-banner')
  const approvalText = document.getElementById('approval-text')
  const queueDock = document.getElementById('queue-dock')

  const md = window.markdownit({ html: false, linkify: true, breaks: true })
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  let running = false
  let activeSessionId = ''
  /** @type {{sessionId:string,title:string,running:boolean}[]} */
  let sessions = []
  /** @type {{rpcId:string, questions:any[]}|null} */
  let pendingQuestion = null
  /** @type {{rpcId:string, approvalId:string, toolName:string, reason?:string}|null} */
  let pendingApproval = null
  /** @type {any|null} */
  let lastSnapshot = null
  let toastTimer = null

  // ---- toast ----
  function toast(kind, text) {
    toastEl.textContent = text
    toastEl.className = `show ${kind || ''}`
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.className = '' }, 3500)
  }

  // ---- scroll ----
  function nearBottom() {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 90
  }
  function scrollToBottom(force) {
    if (force || nearBottom()) scrollEl.scrollTop = scrollEl.scrollHeight
  }

  // ---- session tabs ----
  function renderTabs() {
    tabList.innerHTML = ''
    for (const s of sessions) {
      const wrap = document.createElement('div')
      wrap.className = 'chat-tab-wrap' + (s.sessionId === activeSessionId ? ' active' : '')
      const tab = document.createElement('button')
      tab.className = 'chat-tab' + (s.running ? ' running' : '')
      tab.title = s.sessionId
      tab.textContent = s.title || '会话'
      tab.addEventListener('click', () => {
        if (s.sessionId !== activeSessionId) {
          vscode.postMessage({ type: 'switchSession', sessionId: s.sessionId })
        }
      })
      const openWin = document.createElement('button')
      openWin.className = 'tab-open-win'
      openWin.title = '在编辑器中打开此会话'
      openWin.innerHTML = '<span class="codicon codicon-open-preview"></span>'
      openWin.addEventListener('click', (e) => {
        e.stopPropagation()
        vscode.postMessage({ type: 'openInEditor', sessionId: s.sessionId })
      })
      wrap.appendChild(tab)
      wrap.appendChild(openWin)
      tabList.appendChild(wrap)
    }
  }

  function openHistory() {
    historyPop.classList.toggle('hidden')
    if (!historyPop.classList.contains('hidden')) {
      // Show an immediate "loading" placeholder instead of leaving the popup
      // blank (or stale) during the DSH round-trip, and request the list once
      // (a re-click while loading just re-opens the same request).
      historyList.innerHTML = '<div class="history-empty">加载中…</div>'
      vscode.postMessage({ type: 'listHistory' })
    }
  }

  function renderHistory(items) {
    historyList.innerHTML = ''
    if (!items || items.length === 0) {
      historyList.innerHTML = '<div class="history-empty">没有历史会话</div>'
      return
    }
    for (const item of items) {
      const row = document.createElement('button')
      row.className = 'history-item' + (item.sessionId === activeSessionId ? ' active' : '')
      const title = document.createElement('div')
      title.className = 'history-item-title'
      title.textContent = item.title || '（未命名会话）'
      const meta = document.createElement('div')
      meta.className = 'history-item-meta'
      meta.textContent = item.sessionId.slice(0, 18) + (item.running ? ' · 运行中' : '')
      row.appendChild(title)
      row.appendChild(meta)
      row.addEventListener('click', () => {
        historyPop.classList.add('hidden')
        if (item.sessionId !== activeSessionId) {
          vscode.postMessage({ type: 'switchSession', sessionId: item.sessionId })
        }
      })
      historyList.appendChild(row)
    }
  }

  // ---- turn/item rendering ----
  function turnContainer(turnId) {
    let rec = turns.find((t) => t.turnId === turnId)
    if (rec) return rec
    const head = document.createElement('div')
    head.className = 'turn-head'
    head.innerHTML = '<span class="turn-model"></span><span class="turn-status"></span>'
    const turnEl = document.createElement('div')
    turnEl.className = 'turn'
    turnEl.appendChild(head)
    chatEl.appendChild(turnEl)
    rec = { turnId, el: turnEl, items: new Map(), head }
    turns.push(rec)
    emptyHint.classList.add('hidden')
    return rec
  }

  function updateTurnHead(rec, status, model, errorMessage) {
    const modelEl = rec.head.querySelector('.turn-model')
    const statusEl = rec.head.querySelector('.turn-status')
    if (model) modelEl.textContent = model
    if (status) {
      statusEl.textContent = statusLabel(status)
      statusEl.className = `turn-status ${status}`
    }
    const oldErr = rec.el.querySelector('.turn-error')
    if (errorMessage) {
      if (!oldErr) {
        const err = document.createElement('div')
        err.className = 'turn-error'
        rec.el.appendChild(err)
      }
      rec.el.querySelector('.turn-error').textContent = `本轮失败：${errorMessage}`
    } else if (oldErr) {
      oldErr.remove()
    }
  }

  function statusLabel(status) {
    switch (status) {
      case 'running': return '进行中…'
      case 'done': return '✓ 完成'
      case 'error': return '✗ 失败'
      case 'aborted': return '已停止'
      case 'max-tokens': return '⚠ 达到 token 上限'
      case 'blocked': return '⏸ 阻塞'
      default: return status
    }
  }

  function addItem(turnId, item) {
    const rec = turnContainer(turnId)
    const el = document.createElement('div')
    if (item.kind === 'text') {
      el.className = `msg ${item.role}`
      el.innerHTML = `<div class="avatar">${item.role === 'user' ? '我' : 'D'}</div><div class="body"></div>`
      const body = el.querySelector('.body')
      body.dataset.md = ''
      renderBody(el, item)
      if (item.reasoning) appendReasoning(el, item.reasoning)
    } else {
      el.className = 'msg tool'
      el.appendChild(buildToolCard(item))
    }
    rec.el.appendChild(el)
    rec.items.set(item.id, el)
    scrollToBottom()
  }

  function appendReasoning(msgEl, reasoningText) {
    const body = msgEl.querySelector('.body')
    if (!body) return
    body.dataset.reasoning = reasoningText
    const details = document.createElement('details')
    details.className = 'reasoning'
    details.innerHTML = `<summary>💭 思考过程</summary><div class="reasoning-body"></div>`
    details.querySelector('.reasoning-body').textContent = reasoningText
    msgEl.insertBefore(details, msgEl.querySelector('.body').nextSibling)
  }

  function renderBody(msgEl, item) {
    const body = msgEl.querySelector('.body')
    if (!body) return
    if (body.dataset.md !== item.text) {
      body.dataset.md = item.text
      body.innerHTML = item.text === '' ? '' : md.render(item.text)
      body.querySelectorAll('a').forEach((a) => {
        const href = a.getAttribute('href') || ''
        if (/^https?:\/\//i.test(href)) {
          a.addEventListener('click', (e) => {
            e.preventDefault()
            vscode.postMessage({ type: 'openExternal', url: href })
          })
        }
      })
    }
    const details = msgEl.querySelector('.reasoning')
    const reasonText = item.reasoning || ''
    if (details) {
      const bodyEl = details.querySelector('.reasoning-body')
      if (bodyEl && bodyEl.textContent !== reasonText) bodyEl.textContent = reasonText
    } else if (reasonText) {
      appendReasoning(msgEl, reasonText)
    }
  }

  function buildToolCard(item) {
    const card = document.createElement('details')
    card.className = `tool-card ${item.state}`
    card.dataset.callId = item.callId
    let prettyArgs = item.args
    try { prettyArgs = JSON.stringify(JSON.parse(item.args), null, 2) } catch { /* raw */ }
    card.innerHTML = `
      <summary>
        <span class="tool-icon">🛠</span>
        <span class="tool-name">${escapeHtml(item.name)}</span>
        <span class="tool-state ${item.state}">${toolStateLabel(item.state)}</span>
      </summary>
      <div class="tool-detail">
        <div class="lbl">参数</div>
        <pre class="tool-args">${escapeHtml(prettyArgs)}</pre>
        <div class="tool-result-wrap hidden"><div class="lbl">结果</div><pre class="tool-result"></pre></div>
      </div>`
    const openBtn = document.createElement('button')
    openBtn.className = 'tool-open hidden'
    openBtn.textContent = '在编辑器中打开'
    card.querySelector('.tool-detail').appendChild(openBtn)
    const filePath = detectPath(item)
    if (filePath) {
      openBtn.classList.remove('hidden')
      openBtn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: filePath }))
    }
    updateToolCard(card, item)
    return card
  }

  function toolStateLabel(state) {
    switch (state) {
      case 'running': return '运行中…'
      case 'done': return '✓'
      case 'error': return '✗'
      default: return ''
    }
  }

  function updateToolCard(card, item) {
    card.className = `tool-card ${item.state}`
    const stateEl = card.querySelector('.tool-state')
    if (stateEl) {
      stateEl.textContent = toolStateLabel(item.state)
      stateEl.className = `tool-state ${item.state}`
    }
    const wrap = card.querySelector('.tool-result-wrap')
    if (item.resultText !== undefined && item.resultText !== null && item.resultText !== '') {
      const pre = card.querySelector('.tool-result')
      if (pre) pre.textContent = item.resultText
      if (wrap) wrap.classList.remove('hidden')
    }
  }

  function detectPath(item) {
    if (item.kind !== 'tool') return null
    if (!/write|edit|patch|create|read|move|rename|delete|fs|code|apply/i.test(item.name)) return null
    let args = null
    try { args = JSON.parse(item.args) } catch { return null }
    if (!args || typeof args !== 'object') return null
    const keys = ['path', 'file_path', 'filePath', 'uri', 'filename', 'target', 'destination', 'source']
    for (const k of keys) {
      const v = args[k]
      if (typeof v === 'string' && looksLikePath(v)) return v
    }
    return null
  }

  function looksLikePath(v) {
    if (v.length < 3 || v.length > 400) return false
    return /[\\/]/.test(v) || /\.[a-zA-Z0-9]{1,8}$/.test(v) || /^[A-Za-z]:/.test(v)
  }

  function updateItem(turnId, itemId, patch) {
    const rec = turns.find((t) => t.turnId === turnId)
    if (!rec) return
    const el = rec.items.get(itemId)
    if (!el) return
    if (patch.text !== undefined || patch.reasoning !== undefined) {
      const body = el.querySelector('.body')
      if (body) {
        renderBody(el, { text: patch.text !== undefined ? patch.text : body.dataset.md, reasoning: patch.reasoning })
      }
      scrollToBottom()
    }
    if (patch.state !== undefined || patch.resultText !== undefined || patch.isError !== undefined) {
      const card = el.querySelector('.tool-card')
      if (card) {
        updateToolCard(card, { state: patch.state ?? 'done', resultText: patch.resultText })
      }
      scrollToBottom()
    }
  }

  // ---- snapshot render ----
  /** Find one catalog model entry by `provider/model` (or legacy bare id). */
  function findCatalogEntry(groups, choice) {
    if (!choice) return null
    const slash = choice.indexOf('/')
    if (slash > 0) {
      const g = groups.find((x) => x.id === choice.slice(0, slash))
      const m = g && g.models.find((x) => x.id === choice.slice(slash + 1))
      return m ? { group: g, model: m } : null
    }
    for (const g of groups) {
      const m = g.models.find((x) => x.id === choice)
      if (m) return { group: g, model: m }
    }
    return null
  }

  function capEffort(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

  /**
   * Model selector: the FULL provider-grouped catalog from session.models —
   * same list the DSH Web UI renders. The highlighted value is DSH's own
   * current selection for this session (snapshot.modelCurrent).
   */
  function renderModelSelect(snapshot) {
    const groups = snapshot.catalogGroups || []
    const sig = groups.map((g) => g.id + ':' + g.models.map((m) => m.id).join(',')).join('|')
    if (modelSelect.dataset.sig !== sig) {
      modelSelect.innerHTML = ''
      for (const g of groups) {
        const og = document.createElement('optgroup')
        og.label = g.name
        for (const m of g.models) {
          const o = document.createElement('option')
          o.value = `${g.id}/${m.id}`
          o.textContent = m.name || m.id
          og.appendChild(o)
        }
        modelSelect.appendChild(og)
      }
      modelSelect.dataset.sig = sig
    }
    // Highlight DSH's current selection for this session.
    if (snapshot.modelCurrent) {
      const cur = snapshot.modelCurrent
      const value = `${cur.provider}/${cur.model}`
      if (!findCatalogEntry(groups, value)) {
        // Selection exists but is not in the advisory catalog — keep it
        // visible as its raw id (the Web UI does not synthesize rows either,
        // but a stale pick must still show something truthful).
        let o = Array.from(modelSelect.options).find((x) => x.value === value)
        if (!o) {
          o = document.createElement('option')
          o.value = value
          o.textContent = value
          modelSelect.appendChild(o)
        }
      }
      modelSelect.value = value
    }
  }

  /**
   * Effort selector: the selected model's DECLARED efforts (same list the
   * Web UI renders); '' = provider default. Disabled while the session's
   * current selection is unknown.
   */
  function renderEffortSelect(snapshot) {
    const effortSel = document.getElementById('effort-select')
    const groups = snapshot.catalogGroups || []
    const entry = snapshot.modelCurrent
      ? findCatalogEntry(groups, `${snapshot.modelCurrent.provider}/${snapshot.modelCurrent.model}`)
      : null
    if (!entry) {
      effortSel.disabled = true
      effortSel.title = '未读取到当前模型'
      return
    }
    const efforts = entry.model.efforts || []
    const defaultEffort = entry.model.defaultEffort
    const sig = efforts.join(',') + '|' + (defaultEffort || '')
    if (effortSel.dataset.sig !== sig) {
      effortSel.innerHTML = ''
      if (!defaultEffort) {
        const o = document.createElement('option')
        o.value = ''
        o.textContent = '默认'
        effortSel.appendChild(o)
      }
      for (const e of efforts) {
        const o = document.createElement('option')
        o.value = e
        o.textContent = capEffort(e)
        effortSel.appendChild(o)
      }
      effortSel.dataset.sig = sig
    }
    const cur = snapshot.modelCurrent ? snapshot.modelCurrent.reasoningEffort : undefined
    const value = efforts.includes(cur) ? cur : (defaultEffort || '')
    effortSel.value = value
    effortSel.disabled = false
    effortSel.title = '推理强度'
  }

  // ---- pending queue dock (Web-UI parity) ----
  function renderQueue(queue) {
    const items = Array.isArray(queue) ? queue.filter((q) => q.placement !== 'context') : []
    queueDock.innerHTML = ''
    if (items.length === 0) {
      queueDock.classList.add('hidden')
      return
    }
    queueDock.classList.remove('hidden')
    const head = document.createElement('div')
    head.className = 'queue-head'
    head.textContent = `排队中（${items.length}）：当前任务结束后自动按序执行`
    queueDock.appendChild(head)
    for (const item of items) {
      if (item.placement === 'steering') continue // steering renders inline at the tail
      const row = document.createElement('div')
      row.className = 'queue-row'
      const text = (item.message && item.message.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const body = document.createElement('div')
      body.className = 'queue-text'
      body.textContent = text ? (text.length > 90 ? text.slice(0, 90) + '…' : text) : '（消息）'
      body.title = text
      row.appendChild(body)
      const edit = document.createElement('button')
      edit.className = 'queue-edit'
      edit.textContent = '✎'
      edit.title = '编辑这条排队消息'
      edit.addEventListener('click', () => {
        // Inline edit: swap the text for an input; Enter/blur saves, Esc cancels.
        const input = document.createElement('input')
        input.className = 'queue-edit-input'
        input.type = 'text'
        input.value = text
        input.title = '编辑排队消息，Enter 保存，Esc 取消'
        body.replaceWith(input)
        input.focus()
        input.select()
        let done = false
        const commit = () => {
          if (done) return
          done = true
          const val = input.value.trim()
          if (val !== '' && val !== text) {
            vscode.postMessage({ type: 'editQueued', itemId: item.id, text: val, sessionId: activeSessionId })
          } else {
            input.replaceWith(body)
          }
        }
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') {
            done = true
            input.replaceWith(body)
          }
        })
        input.addEventListener('blur', commit)
      })
      row.appendChild(edit)
      const steer = document.createElement('button')
      steer.className = 'queue-steer'
      steer.textContent = '⤴ 打断插队'
      steer.title = '打断当前任务，优先处理这条消息'
      steer.addEventListener('click', () => {
        vscode.postMessage({ type: 'steerQueued', itemId: item.id, sessionId: activeSessionId })
      })
      row.appendChild(steer)
      const rm = document.createElement('button')
      rm.className = 'queue-rm'
      rm.textContent = '✕'
      rm.title = '从队列移除'
      rm.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeQueued', itemId: item.id, sessionId: activeSessionId })
      })
      row.appendChild(rm)
      queueDock.appendChild(row)
    }
  }

  function renderState(snapshot) {
    lastSnapshot = snapshot
    activeSessionId = snapshot.activeSessionId
    sessions = snapshot.sessions || []
    renderTabs()
    renderQueue(snapshot.queue)
    sessionBar.textContent = snapshot.cwd ? snapshot.cwd : ''
    renderModelSelect(snapshot)
    renderEffortSelect(snapshot)
    // Permission badge.
    const permBadge = document.getElementById('perm-badge')
    const perm = snapshot.permission || ''
    if (Array.isArray(snapshot.permissionOptions) && snapshot.permissionOptions.length > 0) {
      permissionOptions = snapshot.permissionOptions
    }
    permBadge.textContent = perm ? `🛡 ${permLabel(perm)}` : '🛡 …'
    permBadge.title = `当前权限：${perm || '未知'}（点击选择 / Shift+Tab 切换）`
    chatEl.innerHTML = ''
    turns.length = 0
    emptyHint.classList.toggle('hidden', snapshot.turns.length > 0)
    if (snapshot.turns.length > 0) {
      for (const turn of snapshot.turns) {
        const rec = turnContainer(turn.id)
        updateTurnHead(rec, turn.status, turn.model, turn.errorMessage)
        for (const item of turn.items) addItem(turn.id, item)
      }
    }
    if (snapshot.running !== undefined) setRunning(snapshot.running)
    scrollToBottom(true)
  }

  function permLabel(p) {
    switch (p) {
      case 'read-only': return 'read-only'
      case 'workspace-write': return 'workspace-write'
      case 'danger-full-access': return 'full access'
      default: return p
    }
  }

  function setRunning(r) {
    running = r
    // The send button stays enabled while running so the user can queue more
    // messages (they wait in the queue dock instead of being dropped).
    sendBtn.disabled = false
    cancelBtn.classList.toggle('hidden', !r)
    statusText.textContent = r ? '运行中…' : ''
  }

  function setConnection(connected, error) {
    connDot.className = `dot ${connected ? 'on' : 'off'}`
    connText.textContent = connected ? '已连接 DSH' : (error ? `未连接：${error}` : '未连接 DSH')
  }

  // ---- agent questions ----
  // ---- permission approval banner ----
  function renderApproval(rpcId, approvalId, toolName, reason) {
    pendingApproval = { rpcId, approvalId, toolName, reason }
    // Prefer staying stuck on a question if one is open; show alongside it.
    const verb = toolName ? `允许工具 ${toolName} 运行一次` : '允许该操作运行一次'
    approvalText.textContent = reason
      ? `🔐 ${verb}\n原因：${reason}`
      : `🔐 ${verb}`
    approvalBanner.classList.remove('hidden')
  }

  function clearApproval() {
    pendingApproval = null
    approvalBanner.classList.add('hidden')
    approvalText.textContent = ''
  }

  function renderQuestion(rpcId, questions) {
    pendingQuestion = { rpcId, questions }
    questionBody.innerHTML = ''
    for (const item of questions) {
      const block = document.createElement('div')
      block.className = 'q-item'
      block.dataset.qid = item.id
      if (item.header) {
        const h = document.createElement('div')
        h.className = 'q-header'
        h.textContent = item.header
        block.appendChild(h)
      }
      const text = document.createElement('div')
      text.className = 'q-text'
      text.textContent = item.question
      block.appendChild(text)
      if (item.detail) {
        const d = document.createElement('div')
        d.className = 'q-detail'
        d.textContent = item.detail
        block.appendChild(d)
      }
      const multi = item.multiSelect === true
      const opts = item.options || []
      const customInput = document.createElement('input')
      customInput.className = 'q-custom q-custom-input'
      customInput.type = 'text'
      if (opts.length > 0) {
        const list = document.createElement('div')
        list.className = 'q-options'
        for (const opt of opts) {
          const label = document.createElement('label')
          label.className = 'q-option'
          const input = document.createElement('input')
          input.type = multi ? 'checkbox' : 'radio'
          input.name = item.id
          input.value = opt.label
          label.appendChild(input)
          const span = document.createElement('span')
          span.textContent = opt.label
          if (opt.description) {
            const sub = document.createElement('div')
            sub.className = 'q-option-desc'
            sub.textContent = opt.description
            span.appendChild(sub)
          }
          label.appendChild(span)
          list.appendChild(label)
        }
        if (!multi) {
          const other = document.createElement('label')
          other.className = 'q-option'
          const input = document.createElement('input')
          input.type = 'radio'
          input.name = item.id
          input.value = '__custom__'
          other.appendChild(input)
          other.appendChild(document.createTextNode('其他…'))
          list.appendChild(other)
          input.addEventListener('change', () => {
            customInput.classList.toggle('hidden', !input.checked)
            if (input.checked) customInput.focus()
          })
        }
        block.appendChild(list)
        if (multi) {
          customInput.placeholder = '补充说明（可选）'
        } else {
          customInput.classList.add('hidden')
        }
      } else {
        customInput.placeholder = '输入回答'
      }
      block.appendChild(customInput)
      questionBody.appendChild(block)
    }
    questionBanner.classList.remove('hidden')
  }

  function collectAnswers() {
    const answers = []
    const blocks = questionBody.querySelectorAll('.q-item')
    let ok = true
    for (const block of blocks) {
      const qid = block.dataset.qid
      const multi = block.querySelectorAll('input[type=checkbox]').length > 0
      const checked = Array.from(block.querySelectorAll('input:checked')).map((i) => i.value)
      const customInput = block.querySelector('.q-custom-input')
      const custom = customInput && customInput.value.trim() !== '' ? customInput.value.trim() : undefined
      if (multi) {
        answers.push({ id: qid, selected: checked, ...(custom ? { custom } : {}) })
      } else {
        const real = checked.filter((v) => v !== '__custom__')
        const choseOther = checked.includes('__custom__')
        if (choseOther && real.length > 0) {
          toast('warn', '单选问题：选项与其他只能二选一')
          ok = false
          break
        }
        if (custom) {
          answers.push({ id: qid, selected: [], custom })
        } else if (real.length > 0) {
          answers.push({ id: qid, selected: real })
        } else {
          answers.push({ id: qid, selected: [] })
        }
      }
    }
    if (!ok) return null
    return answers
  }

  function clearQuestion() {
    pendingQuestion = null
    questionBanner.classList.add('hidden')
    questionBody.innerHTML = ''
  }

  // ---- message handling ----
  window.addEventListener('message', (event) => {
    const msg = event.data
    switch (msg.type) {
      case 'state':
        renderState(msg.snapshot)
        break
      case 'itemAdd':
        if (msg.sessionId === activeSessionId) addItem(msg.turnId, msg.item)
        break
      case 'itemUpdate':
        if (msg.sessionId === activeSessionId) updateItem(msg.turnId, msg.itemId, msg.patch || {})
        break
      case 'turnStatus':
        if (msg.sessionId === activeSessionId) {
          const rec = turns.find((t) => t.turnId === msg.turnId)
          if (rec) updateTurnHead(rec, msg.status, msg.model, msg.errorMessage)
        }
        break
      case 'runState':
        if (msg.sessionId === activeSessionId) setRunning(msg.running)
        break
      case 'connection':
        setConnection(msg.connected, msg.error)
        break
      case 'toast':
        toast(msg.kind, msg.text)
        break
      case 'question':
        if (msg.sessionId === activeSessionId) renderQuestion(msg.rpcId, msg.questions)
        break
      case 'questionResolved':
        if (msg.sessionId === activeSessionId && pendingQuestion !== null && pendingQuestion.rpcId === msg.rpcId) {
          clearQuestion()
          toast(msg.outcome === 'answered' ? 'info' : 'warn', msg.outcome === 'answered' ? '已提交回答' : '已取消提问')
        }
        break
      case 'approval':
        if (msg.sessionId === activeSessionId) renderApproval(msg.rpcId, msg.approvalId, msg.toolName, msg.reason)
        break
      case 'approvalResolved':
        if (msg.sessionId === activeSessionId && pendingApproval !== null && pendingApproval.approvalId === msg.approvalId) {
          clearApproval()
        }
        break
      case 'history':
        renderHistory(msg.items)
        break
      case 'fileResults':
        if (popupMode === 'at') {
          const items = (msg.files || []).slice(0, 50)
          if (items.length === 0) {
            const query = msg.query || ''
            renderPopup([query === '' ? '（工作区没有文件）' : `未找到 ${query}`], 'at')
          } else {
            renderPopup(items, 'at')
          }
        }
        break
      default:
        break
    }
  })

  // ---- input ----
  const inputPopup = document.getElementById('input-popup')
  let popupItems = []
  let popupIndex = 0
  let popupMode = null // 'at' | 'slash'

  const SLASH_COMMANDS = [
    { name: '/compact', desc: '压缩会话上下文' },
    { name: '/plan', desc: '进入/退出计划模式（off|message）' },
    { name: '/goal', desc: '设置/查看长任务目标' },
    { name: '/permission', desc: '切换权限预设（read-only|workspace-write|danger-full-access）' },
    { name: '/echo', desc: '回显参数' },
  ]

  function closePopup() {
    popupMode = null
    popupItems = []
    inputPopup.classList.add('hidden')
    inputPopup.innerHTML = ''
  }

  function renderPopup(items, mode) {
    popupMode = mode
    popupItems = items
    popupIndex = 0
    if (items.length === 0) {
      closePopup()
      return
    }
    inputPopup.innerHTML = ''
    for (let i = 0; i < items.length; i++) {
      const row = document.createElement('div')
      row.className = 'popup-row' + (i === 0 ? ' selected' : '')
      if (mode === 'slash') {
        const name = document.createElement('span')
        name.className = 'popup-name'
        name.textContent = items[i].name
        const desc = document.createElement('span')
        desc.className = 'popup-desc'
        desc.textContent = items[i].desc || ''
        row.appendChild(name)
        row.appendChild(desc)
      } else {
        const name = document.createElement('span')
        name.className = 'popup-name'
        name.textContent = items[i]
        row.appendChild(name)
      }
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        insertPopupItem(items[i], mode)
      })
      inputPopup.appendChild(row)
    }
    inputPopup.classList.remove('hidden')
    updatePopupSelection()
  }

  function updatePopupSelection() {
    const rows = inputPopup.querySelectorAll('.popup-row')
    rows.forEach((r, i) => r.classList.toggle('selected', i === popupIndex))
    const sel = rows[popupIndex]
    if (sel) sel.scrollIntoView({ block: 'nearest' })
  }

  function insertPopupItem(item, mode) {
    const val = inputEl.value
    // Replace the trailing token (last @word or /word) with the pick.
    const m = val.match(/(^|\s)([@/])[^\s@/]*$/)
    if (m) {
      const prefix = val.slice(0, m.index + m[1].length)
      const insert = mode === 'slash' ? item.name : '@' + item
      inputEl.value = prefix + insert + ' '
      inputEl.focus()
      autoGrow()
    }
    closePopup()
  }

  function updatePopup() {
    const val = inputEl.value
    const caret = inputEl.selectionStart ?? val.length
    const before = val.slice(0, caret)
    const m = before.match(/(^|\s)([@/])([^\s@/]*)$/)
    if (!m) {
      closePopup()
      return
    }
    const trigger = m[2]
    const query = m[3]
    if (trigger === '/') {
      const items = SLASH_COMMANDS.filter((c) => c.name.startsWith('/' + query.toLowerCase()))
      renderPopup(items, 'slash')
    } else if (trigger === '@') {
      vscode.postMessage({ type: 'findFiles', query })
      // show "searching" state briefly; results arrive async
      if (popupMode !== 'at') {
        renderPopup([query === '' ? '搜索中…' : `搜索 ${query}…`], 'at')
      }
    }
  }

  function autoGrow() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px'
  }
  inputEl.addEventListener('input', () => {
    autoGrow()
    updatePopup()
  })
  inputEl.addEventListener('keydown', (e) => {
    if (popupMode !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        popupIndex = (popupIndex + 1) % popupItems.length
        updatePopupSelection()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        popupIndex = (popupIndex - 1 + popupItems.length) % popupItems.length
        updatePopupSelection()
        return
      }
      if (e.key === 'Enter' && popupMode === 'at' && popupItems[0] !== undefined && popupItems[0].startsWith('搜索')) {
        e.preventDefault()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = popupItems[popupIndex]
        if (item !== undefined) insertPopupItem(item, popupMode)
        return
      }
      if (e.key === 'Escape') {
        closePopup()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Ctrl/Cmd+Enter = steer (jump the queue / interject into the current
      // turn's step queue), mirroring the DSH Web UI composer shortcut.
      if (e.ctrlKey || e.metaKey) sendSteer()
      else send()
    }
  })
  sendBtn.addEventListener('click', send)
  function send() {
    const text = inputEl.value
    if (!text.trim()) return
    // Sending while the agent is busy is allowed: the controller enqueues the
    // message (DSH Web-UI parity) and it shows up in the queue dock.
    inputEl.value = ''
    autoGrow()
    vscode.postMessage({ type: 'send', text, sessionId: activeSessionId })
  }
  function sendSteer() {
    const text = inputEl.value
    if (!text.trim()) return
    inputEl.value = ''
    autoGrow()
    // steer: true → controller sends with mode:'steer' (interject into current step)
    vscode.postMessage({ type: 'send', text, steer: true, sessionId: activeSessionId })
  }
  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel', sessionId: activeSessionId })
  })
  modelSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setModelChoice', model: modelSelect.value })
  })
  // Web UI parity: the picker reloads its directory every time it opens, so
  // providers/models DSH added since the last open show up immediately.
  modelSelect.addEventListener('mousedown', () => {
    vscode.postMessage({ type: 'refreshCatalog', sessionId: activeSessionId })
  })
  document.getElementById('effort-select').addEventListener('change', () => {
    vscode.postMessage({ type: 'setEffort', effort: document.getElementById('effort-select').value })
  })

  // ---- permission badge: click opens a picker, Shift+Tab cycles ----
  const permBadgeEl = document.getElementById('perm-badge')
  const permMenu = document.createElement('div')
  permMenu.className = 'perm-menu hidden'
  document.getElementById('dsh-footer').appendChild(permMenu)
  let permissionOptions = ['read-only', 'workspace-write', 'danger-full-access']

  function renderPermMenu() {
    permMenu.innerHTML = ''
    const cur = (lastSnapshot && lastSnapshot.permission) || ''
    for (const p of permissionOptions) {
      const row = document.createElement('button')
      row.className = 'perm-menu-item' + (p === cur ? ' active' : '')
      row.textContent = permLabel(p)
      row.addEventListener('click', () => {
        permMenu.classList.add('hidden')
        vscode.postMessage({ type: 'setPermission', preset: p, sessionId: activeSessionId })
      })
      permMenu.appendChild(row)
    }
  }

  permBadgeEl.addEventListener('click', (e) => {
    e.stopPropagation()
    renderPermMenu()
    permMenu.classList.toggle('hidden')
  })
  document.addEventListener('click', (e) => {
    if (!permMenu.classList.contains('hidden') && !permMenu.contains(e.target) && e.target !== permBadgeEl) {
      permMenu.classList.add('hidden')
    }
  })
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      vscode.postMessage({ type: 'cyclePermission', sessionId: activeSessionId })
    }
  })
  document.getElementById('btn-new-tab').addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' })
  })
  document.getElementById('btn-new-window').addEventListener('click', () => {
    vscode.postMessage({ type: 'newWindow' })
  })
  document.getElementById('btn-question-submit').addEventListener('click', () => {
    if (pendingQuestion === null) return
    const answers = collectAnswers()
    if (answers === null) return
    vscode.postMessage({ type: 'answerQuestion', rpcId: pendingQuestion.rpcId, answers, sessionId: activeSessionId })
  })
  document.getElementById('btn-question-cancel').addEventListener('click', () => {
    if (pendingQuestion === null) return
    vscode.postMessage({ type: 'cancelQuestion', rpcId: pendingQuestion.rpcId, sessionId: activeSessionId })
    clearQuestion()
  })
  document.getElementById('btn-approval-allow').addEventListener('click', () => {
    if (pendingApproval === null) return
    const p = pendingApproval
    vscode.postMessage({ type: 'answerApproval', rpcId: p.rpcId, approvalId: p.approvalId, sessionId: activeSessionId })
    clearApproval()
  })
  document.getElementById('btn-approval-reject').addEventListener('click', () => {
    if (pendingApproval === null) return
    const p = pendingApproval
    vscode.postMessage({ type: 'rejectApproval', rpcId: p.rpcId, approvalId: p.approvalId, sessionId: activeSessionId })
    clearApproval()
  })
  btnHistory.addEventListener('click', openHistory)
  document.addEventListener('click', (e) => {
    // `.contains` (not `e.target !== btnHistory`): clicking the codicon glyph
    // inside the button targets the child <span>, which would otherwise be
    // treated as an outside click and instantly re-close the popup we just
    // opened — making the history button appear dead when clicked on the icon.
    if (!historyPop.classList.contains('hidden') && !historyPop.contains(e.target) && !btnHistory.contains(e.target)) {
      historyPop.classList.add('hidden')
    }
  })

  // initial handshake
  vscode.postMessage({ type: 'ready' })
})()

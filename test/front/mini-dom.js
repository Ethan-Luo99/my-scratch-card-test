/**
 * 极简 DOM 桩（仅服务于 node --test，零第三方依赖）。
 * 支持：元素树、class/dataset/style、innerHTML 的小型 HTML 解析（覆盖本仓库
 * 模板用到的标签/属性）、querySelector('.cls'|'tag'|'#id')、事件收集与派发、
 * textContent DFS 聚合。canvas.getContext 返回可记录调用的 2d context 桩。
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function parseAttrs(raw) {
  const attrs = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+)))?/g
  let match
  while ((match = re.exec(raw))) {
    attrs[match[1]] = match[3] ?? match[4] ?? match[5] ?? ''
  }
  return attrs
}

class ClassList {
  constructor(element) {
    this.el = element
  }
  values() {
    return (this.el.attrs.class || '').split(/\s+/).filter(Boolean)
  }
  add(...names) {
    const set = new Set(this.values())
    names.forEach((name) => set.add(name))
    this.el.attrs.class = Array.from(set).join(' ')
  }
  remove(...names) {
    const drop = new Set(names)
    this.el.attrs.class = this.values().filter((name) => !drop.has(name)).join(' ')
  }
  toggle(name, force) {
    const has = this.contains(name)
    const next = force === undefined ? !has : Boolean(force)
    if (next) this.add(name)
    else this.remove(name)
    return next
  }
  contains(name) {
    return this.values().includes(name)
  }
}

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.attrs = {}
    this.children = []
    this.style = {}
    this.dataset = {}
    this.classList = new ClassList(this)
    this.listeners = new Map()
    this.clientWidth = tagName === 'canvas' ? 320 : 0
    this.clientHeight = tagName === 'canvas' ? 180 : 0
    this._innerHTML = ''
    this.width = 300
    this.height = 150
  }

  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }

  getAttribute(name) {
    return this.attrs[name] ?? null
  }

  hasAttribute(name) {
    return name in this.attrs
  }

  get hidden() {
    return 'hidden' in this.attrs
  }

  set hidden(value) {
    if (value) this.attrs.hidden = ''
    else delete this.attrs.hidden
  }

  get disabled() {
    return 'disabled' in this.attrs
  }

  set disabled(value) {
    if (value) this.attrs.disabled = ''
    else delete this.attrs.disabled
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(type, list.filter((item) => item !== fn))
  }

  dispatch(type, event = {}) {
    const list = this.listeners.get(type) || []
    return list.map((fn) => fn.call(this, event))
  }

  setPointerCapture() {}
  releasePointerCapture() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }
  }

  getContext() {
    return recording2dContext(this)
  }

  set innerHTML(markup) {
    this._innerHTML = markup
    this.children = parseFragment(markup)
    for (const child of walk(this.children)) child.parent = this
  }

  get innerHTML() {
    return this._innerHTML
  }

  get textContent() {
    return collectText(this).replace(/\s+/g, ' ').trim()
  }

  set textContent(value) {
    this.children = [{ isText: true, value: String(value) }]
  }

  querySelector(selector) {
    return findOne(this, selector)
  }

  querySelectorAll(selector) {
    return findAll(this, selector)
  }

  focus() {}
}

function walk(nodes) {
  const out = []
  for (const node of nodes) {
    out.push(node)
    if (!node.isText) out.push(...walk(node.children))
  }
  return out
}

function collectText(element) {
  let text = ''
  for (const child of element.children) {
    if (child.isText) text += child.value
    else text += collectText(child)
  }
  return text
}

function parseFragment(markup) {
  const root = { children: [] }
  const stack = [root]
  const token = /<(!--[\s\S]*?--|\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>|([^<]+)/g
  let match
  while ((match = token.exec(markup))) {
    if (match[0].startsWith('<!--')) continue
    if (match[2]) {
      const isClose = match[1] === '/'
      const tag = match[2].toLowerCase()
      if (isClose) {
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].tagName === tag.toUpperCase()) {
            stack.length = i
            break
          }
        }
        continue
      }
      const element = new Element(tag)
      Object.assign(element.attrs, parseAttrs(match[3] || ''))
      if (element.attrs['data-state']) element.dataset.state = element.attrs['data-state']
      stack[stack.length - 1].children.push(element)
      const selfClose = match[4] === '/' || VOID_TAGS.has(tag)
      if (!selfClose) stack.push(element)
    } else if (match[5] !== undefined) {
      const value = match[5]
      if (value.trim()) stack[stack.length - 1].children.push({ isText: true, value })
    }
  }
  return root.children
}

function matchSelector(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1))
  if (selector.startsWith('#')) return element.attrs.id === selector.slice(1)
  return element.tagName === selector.toUpperCase()
}

function findOne(scope, selector) {
  for (const child of walk(scope.children)) {
    if (!child.isText && matchSelector(child, selector)) return child
  }
  return null
}

function findAll(scope, selector) {
  return walk(scope.children).filter((child) => !child.isText && matchSelector(child, selector))
}

function recording2dContext(canvas) {
  if (canvas.__ctx) return canvas.__ctx
  const gradient = { addColorStop() {} }
  const pattern = {}
  const ctx = {
    calls: [],
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    setTransform() {},
    drawImage() {},
    beginPath() {
      this.calls.push('beginPath')
    },
    moveTo() {},
    lineTo() {},
    stroke() {
      this.calls.push('stroke')
    },
    arc() {},
    fill() {
      this.calls.push('fill')
    },
    createLinearGradient() {
      return gradient
    },
    createPattern() {
      return pattern
    },
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) }
    },
    putImageData() {},
    fillText() {},
    measureText: () => ({ width: 0 }),
  }
  Object.defineProperty(ctx, 'globalCompositeOperation', { value: 'source-over', writable: true })
  Object.defineProperty(ctx, 'globalAlpha', { value: 1, writable: true })
  Object.defineProperty(ctx, 'fillStyle', { value: '', writable: true })
  Object.defineProperty(ctx, 'strokeStyle', { value: '', writable: true })
  Object.defineProperty(ctx, 'lineWidth', { value: 1, writable: true })
  Object.defineProperty(ctx, 'lineCap', { value: '', writable: true })
  Object.defineProperty(ctx, 'lineJoin', { value: '', writable: true })
  Object.defineProperty(ctx, 'font', { value: '', writable: true })
  Object.defineProperty(ctx, 'textAlign', { value: '', writable: true })
  Object.defineProperty(ctx, 'textBaseline', { value: '', writable: true })
  canvas.__ctx = ctx
  return ctx
}

/** 安装 card/scratch-layer 所需的全局 window/document/ResizeObserver；返回卸载函数 */
export function installDom() {
  const elements = []
  const documentStub = {
    createElement(tag) {
      const element = new Element(tag)
      elements.push(element)
      return element
    },
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
  }
  const windowListeners = new Map()
  const windowStub = {
    devicePixelRatio: 2,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, [])
      windowListeners.get(type).push(fn)
    },
    removeEventListener() {},
  }
  class ResizeObserverStub {
    constructor(fn) {
      this.fn = fn
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
  }
  globalThis.document = documentStub
  globalThis.window = windowStub
  globalThis.ResizeObserver = ResizeObserverStub

  return {
    document: documentStub,
    window: windowStub,
    elements,
    /** 找到 component 内部创建的离屏/显示 canvas 及其记录上下文 */
    canvases() {
      return elements.filter((element) => element.tagName === 'CANVAS')
    },
    restore() {
      globalThis.document = previous.document
      globalThis.window = previous.window
      globalThis.ResizeObserver = previous.ResizeObserver
    },
  }
}

/**
 * 前端测试工具：内存 Storage（模拟 localStorage）、共享锁、最小 DOM 桩。
 * 不引入任何第三方依赖（无 jsdom），只实现被测代码用到的最小 API 面。
 */
import { createKvBackend } from '../../src/storage/backend.js'
import { createLockManager } from '../../src/storage/sync.js'

/** 符合 Storage 接口子集的内存实现（含 length/key(i)，供 keys() 枚举） */
export function createMemoryStorage() {
  const map = new Map()
  return {
    get length() {
      return map.size
    },
    key(index) {
      return [...map.keys()][index] ?? null
    },
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    _map: map,
  }
}

export function createMemoryBackend() {
  const storage = createMemoryStorage()
  return { storage, backend: createKvBackend(() => storage) }
}

/** 共享锁（模拟同源多标签页的 navigator.locks：同 name 串行） */
export function createSharedLocks() {
  const tails = new Map()
  const api = {
    request(name, _options, fn) {
      const prev = tails.get(name) || Promise.resolve()
      const next = Promise.resolve(prev).then(fn)
      tails.set(
        name,
        next.then(
          () => {},
          () => {},
        ),
      )
      return next
    },
  }
  return {
    a: createLockManager(api),
    b: createLockManager(api),
  }
}

/** 扫描后端全部 key/value，返回拼接文本（localStorage 全量扫描断言用） */
export function dumpStorage(backend) {
  const parts = []
  for (const key of backend.keys()) {
    parts.push(key)
    parts.push(backend.getItem(key) ?? '')
  }
  return parts.join('\n')
}

// ---------------- 最小 DOM 桩 ----------------

class FakeClassList {
  constructor() {
    this._set = new Set()
  }
  add(...names) {
    names.forEach((name) => this._set.add(name))
  }
  remove(...names) {
    names.forEach((name) => this._set.delete(name))
  }
  toggle(name, force) {
    const want = force === undefined ? !this._set.has(name) : Boolean(force)
    if (want) this._set.add(name)
    else this._set.delete(name)
    return want
  }
  contains(name) {
    return this._set.has(name)
  }
}

export class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.parentNode = null
    this.className = ''
    this.classList = new FakeClassList()
    this.dataset = {}
    this.style = {}
    this.attributes = {}
    this.hidden = false
    this.disabled = false
    this.textContent = ''
    this._innerHTML = ''
    this._listeners = new Map()
    this._queryCache = new Map()
    // canvas 相关默认值
    this.clientWidth = 320
    this.clientHeight = 180
    this.width = 0
    this.height = 0
  }
  set innerHTML(value) {
    this._innerHTML = String(value)
  }
  get innerHTML() {
    return this._innerHTML
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }
  getAttribute(name) {
    return this.attributes[name] ?? null
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }
  dispatch(type, event = {}) {
    for (const fn of this._listeners.get(type) ?? []) fn(event)
  }
  querySelector(selector) {
    if (!this._queryCache.has(selector)) {
      const el = new FakeElement(selector.includes('canvas') ? 'canvas' : 'div', this.ownerDocument)
      el._selector = selector
      this._queryCache.set(selector, el)
    }
    return this._queryCache.get(selector)
  }
  querySelectorAll() {
    return []
  }
  focus() {}
  // ---- canvas 子集 ----
  getContext() {
    if (!this._ctx) this._ctx = createFakeContext()
    return this._ctx
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }
  }
}

export function createFakeContext() {
  const calls = { stroke: 0, fill: 0, fillRect: 0, drawImage: 0, fillText: 0 }
  const gradient = { addColorStop() {} }
  return {
    calls,
    canvas: null,
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {},
    fillRect() {
      calls.fillRect += 1
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    stroke() {
      calls.stroke += 1
    },
    fill() {
      calls.fill += 1
    },
    drawImage() {
      calls.drawImage += 1
    },
    fillText() {
      calls.fillText += 1
    },
    createLinearGradient: () => gradient,
    createPattern: () => ({}),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
  }
}

class FakeResizeObserver {
  constructor(callback) {
    this._callback = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 安装全局 DOM 桩，返回清理函数 */
export function installDomStub() {
  const documentStub = {
    hidden: false,
    _listeners: new Map(),
    createElement: (tag) => new FakeElement(tag, documentStub),
    querySelector: () => null,
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) ?? []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
  }
  const windowStub = {
    devicePixelRatio: 2,
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) ?? []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  }
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
  }
  globalThis.document = documentStub
  globalThis.window = windowStub
  globalThis.ResizeObserver = FakeResizeObserver
  return {
    document: documentStub,
    window: windowStub,
    restore() {
      if (previous.document === undefined) delete globalThis.document
      else globalThis.document = previous.document
      if (previous.window === undefined) delete globalThis.window
      else globalThis.window = previous.window
      if (previous.ResizeObserver === undefined) delete globalThis.ResizeObserver
      else globalThis.ResizeObserver = previous.ResizeObserver
    },
  }
}

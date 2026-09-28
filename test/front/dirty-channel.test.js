/**
 * 设计 4.4：跨标签页只传 dirty 提示（无结果字段），收到后由控制器拉 /state。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirtyChannel } from '../../src/client/dirty-channel.js'

class FakeBroadcastChannel {
  static instances = []
  constructor(name) {
    this.name = name
    this.onmessage = null
    this.posted = []
    FakeBroadcastChannel.instances.push(this)
  }
  postMessage(message) {
    this.posted.push(message)
    // 投递给其他实例
    for (const instance of FakeBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && instance.onmessage) {
        instance.onmessage({ data: message })
      }
    }
  }
  close() {}
}

test('BroadcastChannel：只广播 dirty+rev，消息体不含 prize/seed/承诺', () => {
  FakeBroadcastChannel.instances = []
  const a = createDirtyChannel({ BroadcastChannelCtor: FakeBroadcastChannel })
  const b = createDirtyChannel({ BroadcastChannelCtor: FakeBroadcastChannel })
  const received = []
  b.onChange((message) => received.push(message))
  a.postDirty({ campaignId: 'daily', cardId: 'daily-1', rev: 7 })
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { type: 'dirty', campaignId: 'daily', cardId: 'daily-1', rev: 7 })
  for (const key of ['prize', 'seed', 'seedHex', 'receipt', 'commitment']) {
    assert.equal(received[0][key], undefined)
  }
  a.destroy()
  b.destroy()
})

test('非法消息被丢弃', () => {
  FakeBroadcastChannel.instances = []
  const a = createDirtyChannel({ BroadcastChannelCtor: FakeBroadcastChannel })
  const b = createDirtyChannel({ BroadcastChannelCtor: FakeBroadcastChannel })
  const received = []
  b.onChange((message) => received.push(message))
  const raw = FakeBroadcastChannel.instances[0]
  raw.postMessage({ type: 'envelope', prize: '88元 现金红包' })
  raw.postMessage({ prize: '免费咖啡一杯' })
  raw.postMessage(null)
  assert.equal(received.length, 0)
  // rev 非数字时归一为 null，但 dirty 语义消息仍投递（轮询兜底场景）
  raw.postMessage({ type: 'dirty', rev: 'bad' })
  assert.equal(received.length, 1)
  assert.equal(received[0].rev, null)
  a.destroy()
  b.destroy()
})

test('无 BroadcastChannel 时 storage 事件兜底（storageFactory 写入）', async () => {
  const listeners = new Map()
  const stored = new Map()
  const storage = {
    setItem: (key, value) => stored.set(key, value),
    getItem: (key) => stored.get(key) ?? null,
    removeItem: (key) => stored.delete(key),
  }
  globalThis.window = {
    addEventListener(type, fn) {
      listeners.set(type, fn)
    },
    removeEventListener() {},
  }
  const a = createDirtyChannel({ BroadcastChannelCtor: null, storageFactory: () => storage })
  const b = createDirtyChannel({ BroadcastChannelCtor: null, storageFactory: () => storage })
  const received = []
  b.onChange((message) => received.push(message))
  a.postDirty({ campaignId: 'daily', cardId: 'daily-2', rev: 3 })
  const key = 'scratch:v1:dirty-marker'
  assert.ok(stored.has(key))
  listeners.get('storage')({ key, newValue: stored.get(key) })
  assert.equal(received.length, 1)
  assert.equal(received[0].cardId, 'daily-2')
  assert.equal(received[0].prize, undefined)
  delete globalThis.window
  a.destroy()
  b.destroy()
})

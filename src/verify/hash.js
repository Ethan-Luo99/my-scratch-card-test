/**
 * SHA-256 小工具（浏览器 WebCrypto；Node 测试环境同样提供 globalThis.crypto）。
 * 仅用于：迁移 payload 指纹、揭晓后承诺重算。不参与任何未揭晓流程。
 */
export async function createHashHex(text) {
  const data = new TextEncoder().encode(String(text))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

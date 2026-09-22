/**
 * 轻量提示条（UI 工具）。
 * 职责边界：只负责短暂文本提示的展示与自动消失。
 */

let el = null
let timer = 0

export function showToast(message) {
  if (!el) {
    el = document.createElement('div')
    el.className = 'toast'
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    document.body.appendChild(el)
  }
  el.textContent = message
  el.classList.add('is-visible')
  clearTimeout(timer)
  timer = setTimeout(() => el.classList.remove('is-visible'), 2400)
}

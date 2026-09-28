/**
 * 确定性 JSON：对象键按字典序递归排序（与服务端 signer 的 canonicalJSON 一致）。
 * 仅用于揭晓后的签名复核。
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
    .join(',')}}`
}

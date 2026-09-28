/**
 * 页面装配层（服务端权威版）。
 *
 * 启动顺序：检测旧本地数据 →（有则迁移向导锁定导入）→ 建立会话 →
 * 拉取服务端公开视图注水 → 渲染。任何一步失败都退化为只读/锁定，
 * 绝不本地摇奖。两个活动各持独立控制器，状态完全隔离。
 */
import './style.css'
import { createApiClient, ApiProtocolError } from './api/client.js'
import { createClientCache } from './client/cache.js'
import { createDirtyChannel } from './client/dirty-channel.js'
import { createCampaignController } from './app/campaign-controller.js'
import { createMigrationWizard } from './app/migration.js'
import { createScratchCard } from './card.js'

const CAMPAIGNS_META = [
  { id: 'daily', theme: 'daily', fallbackTitle: '每日刮刮卡', fallbackSubtitle: '每日 3 次机会，刮开涂层赢好礼' },
  { id: 'weekend', theme: 'weekend', fallbackTitle: '周末狂欢卡', fallbackSubtitle: '周末限定：每日 5 次机会，赢 iPhone 抽奖券' },
]

const POLL_INTERVAL_MS = 20_000

const cache = createClientCache()
const api = createApiClient()
const dirtyChannel = createDirtyChannel()
const migration = createMigrationWizard({ api, cache })

document.querySelector('#app').innerHTML = `
  <header class="site-header">
    <h1>幸运刮刮卡</h1>
    <p class="subtitle">多活动同台 · 多标签页共享每日次数 · 开奖可验证</p>
    <p class="offline-banner" id="offline-banner" role="status" hidden>
      服务端暂时不可用，已进入只读模式：已揭晓内容可查看，暂不能刮卡或领奖
    </p>
    <p class="storage-hint" id="storage-hint" hidden>
      当前环境不支持本地存储：离线缓存与公平性承诺存档不可用，在线体验不受影响
    </p>
  </header>
  <main id="campaigns"></main>
  <div class="modal-backdrop" id="modal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title"></h2>
      <p id="modal-desc"></p>
      <button type="button" class="verify-toggle" id="verify-toggle" hidden>🔍 公平性验证</button>
      <div class="verify-panel" id="verify-panel" hidden></div>
      <div class="modal-actions">
        <button type="button" class="btn-primary" id="modal-claim"></button>
        <button type="button" class="btn-ghost" id="modal-close">稍后再说</button>
      </div>
    </div>
  </div>
  <div class="modal-backdrop migration-backdrop" id="migration-overlay" hidden>
    <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="migration-title">
      <h2 id="migration-title">正在迁移历史记录</h2>
      <p id="migration-desc">检测到旧版本地数据，正在上传到服务端登记（只读，不影响新刮卡）…</p>
      <div class="modal-actions">
        <button type="button" class="btn-primary" id="migration-retry" hidden>重试迁移</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`

const offlineBanner = document.querySelector('#offline-banner')
const storageHint = document.querySelector('#storage-hint')
const modal = document.querySelector('#modal')
const modalTitle = document.querySelector('#modal-title')
const modalDesc = document.querySelector('#modal-desc')
const modalClaim = document.querySelector('#modal-claim')
const modalClose = document.querySelector('#modal-close')
const verifyToggle = document.querySelector('#verify-toggle')
const verifyPanel = document.querySelector('#verify-panel')
const toast = document.querySelector('#toast')
const migrationOverlay = document.querySelector('#migration-overlay')
const migrationDesc = document.querySelector('#migration-desc')
const migrationRetry = document.querySelector('#migration-retry')

let toastTimer = null
function notify(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600)
}

const controllers = new Map()
let modalCampaignId = null
let modalCardId = null
let verificationKeyInfo = null

function openResultModal(campaignId, cardId) {
  const controller = controllers.get(campaignId)
  const card = controller?.getCard(cardId)
  if (!card || !card.prize) return
  modalCampaignId = campaignId
  modalCardId = cardId
  modalTitle.textContent = card.prize.win ? '🎉 恭喜中奖！' : '谢谢参与'
  modalDesc.textContent = card.prize.win
    ? `你获得了「${card.prize.name}」，领取后可在其他页面查看。`
    : '很遗憾这次没有中奖，明天再来试试手气吧。'
  modalClaim.textContent = card.prize.win ? '立即领取' : '知道了'
  modalClaim.disabled = !controller.online
  // 公平性入口只对已揭晓卡出现（未揭晓卡根本没有打开弹窗的路径）
  verifyToggle.hidden = false
  verifyToggle.textContent = '🔍 公平性验证'
  verifyToggle.disabled = false
  verifyPanel.hidden = true
  verifyPanel.innerHTML = ''
  modal.hidden = false
  modalClaim.focus()
}

function closeModal() {
  modal.hidden = true
  modalCampaignId = null
  modalCardId = null
}

modalClaim.addEventListener('click', async () => {
  if (!modalCampaignId) return closeModal()
  const controller = controllers.get(modalCampaignId)
  const card = controller.getCard(modalCardId)
  modalClaim.disabled = true
  let result
  try {
    // 无论中奖与否都推进 claim（消除"已刮开未领取"悬挂态），
    // 并发先到先得由服务端裁决
    result = await controller.claim(modalCardId)
  } catch {
    notify('网络异常，领取未成功，请稍后重试')
    modalClaim.disabled = false
    return
  }
  if (!result.ok) {
    if (result.reason === 'offline') {
      notify('网络不可用，恢复后再领取')
    } else if (card?.prize?.win) {
      notify('领取失败：该奖品已在其他标签页被领取（先到先得）')
    }
    closeModal()
    return
  }
  if (card?.prize?.win) notify('领取成功，可在"我的奖品"中查看')
  closeModal()
})
modalClose.addEventListener('click', closeModal)
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modal.hidden) closeModal()
})

async function ensureVerificationKey() {
  if (verificationKeyInfo) return verificationKeyInfo
  try {
    verificationKeyInfo = await api.getVerificationKey()
    cache.saveVerificationKey(verificationKeyInfo)
  } catch {
    verificationKeyInfo = cache.loadVerificationKey()
  }
  return verificationKeyInfo
}

verifyToggle.addEventListener('click', async () => {
  if (!modalCampaignId) return
  const controller = controllers.get(modalCampaignId)
  const card = controller.getCard(modalCardId)
  if (!card || !card.receipt) return
  verifyToggle.disabled = true
  verifyToggle.textContent = '验证中…'
  verifyPanel.hidden = false
  verifyPanel.innerHTML = '<p class="verify-note">正在核对承诺与签名…</p>'
  try {
    const [{ verifyRevealedCard }, publicKey] = await Promise.all([
      import('./verify/verify-receipt.js'),
      ensureVerificationKey(),
    ])
    const commitment = cache.loadCommitments(card.campaignId)[card.cardId]?.commitment ?? null
    const report = await verifyRevealedCard({ card, commitment, publicKey })
    const mark = (check, passText, failText, skipText) => {
      if (check.status === 'pass') return `✅ ${passText}`
      if (check.status === 'fail') return `❌ ${failText}`
      return `— ${skipText}`
    }
    verifyPanel.innerHTML = `
      <dl>
        <dt>随机种子 seed</dt><dd>${report.seedHex ?? '—'}</dd>
        <dt>承诺 SHA-256</dt><dd>${mark(report.commitmentCheck, '与服务端承诺一致', '与服务端承诺不一致', '无承诺存档（历史迁移卡）')}</dd>
        <dt>回执签名</dt><dd>${mark(report.signatureCheck, 'Ed25519 验签通过', '验签失败', '公钥不可用，无法验签')}</dd>
        <dt>权重重算</dt><dd>${mark(report.replayCheck, '重算结果与下发奖品一致', '重算结果不一致', '权重快照不可用')}</dd>
        <dt>算法版本</dt><dd>${report.weightsVersion ?? '—'}</dd>
      </dl>
      <p class="verify-note">结果在刮开前已由服务端承诺（SHA-256 + Ed25519 签名）固定；
        任何人可用公开权重与 seed 重算核对，服务端无法在刮开后调换结果。</p>
    `
    verifyToggle.textContent = report.allPassed ? '✅ 已验证' : '⚠️ 存在不一致项'
  } catch {
    verifyPanel.innerHTML = '<p class="verify-note">当前环境不支持本地验签，可稍后再试。</p>'
    verifyToggle.textContent = '🔍 公平性验证'
  } finally {
    verifyToggle.disabled = false
  }
})

function buildCampaignSection(meta, controller) {
  const section = document.createElement('section')
  section.className = 'campaign'
  section.dataset.theme = meta.theme
  section.innerHTML = `
    <div class="campaign-head">
      <h2>${meta.fallbackTitle}</h2>
      <p class="campaign-sub">${meta.fallbackSubtitle}</p>
      <p class="chances" aria-live="polite"></p>
      <p class="time-anomaly" hidden>⚠️ 检测到系统时间异常，今日次数与状态继续沿用</p>
    </div>
    <div class="cards"></div>
  `
  const chancesEl = section.querySelector('.chances')
  const anomalyEl = section.querySelector('.time-anomaly')
  const grid = section.querySelector('.cards')

  const cards = controller.getSnapshot().cardIds.map((cardId) =>
    createScratchCard({
      id: cardId,
      controller,
      notify,
      onRevealed: (cardId) => openResultModal(meta.id, cardId),
    }),
  )
  for (const card of cards) grid.appendChild(card.el)

  function render() {
    const snapshot = controller.getSnapshot()
    section.querySelector('h2').textContent = snapshot.title ?? meta.fallbackTitle
    section.querySelector('.campaign-sub').textContent = snapshot.subtitle ?? meta.fallbackSubtitle
    if (snapshot.chancesLeft == null || snapshot.dailyChances == null) {
      chancesEl.textContent = '今日剩余次数：—'
      chancesEl.classList.remove('is-empty')
    } else {
      chancesEl.textContent = `今日剩余次数：${snapshot.chancesLeft} / ${snapshot.dailyChances}`
      chancesEl.classList.toggle('is-empty', snapshot.chancesLeft === 0)
    }
    anomalyEl.hidden = !snapshot.clockAnomaly
    for (const card of cards) card.update()
  }

  controller.onChange(render)
  render()
  return section
}

function updateOfflineBanner() {
  const anyOnline = Array.from(controllers.values()).some((controller) => controller.online)
  offlineBanner.hidden = anyOnline
}

async function refreshAll() {
  const results = await Promise.all(Array.from(controllers.values()).map((c) => c.refresh()))
  updateOfflineBanner()
  return results
}

async function ensureSession() {
  try {
    // 已有会话：直接拉全量视图（避免每次刷新都新建会话）
    const view = await api.recover()
    return view
  } catch (error) {
    if (error instanceof ApiProtocolError && error.error === 'no-session') {
      const session = await api.createSession()
      cache.saveSessionMeta(session)
      return api.recover()
    }
    throw error
  }
}

async function runMigrationIfNeeded() {
  const legacy = migration.detectLegacy()
  if (legacy.length === 0) return true
  migrationOverlay.hidden = false
  migrationRetry.hidden = true
  migrationDesc.textContent = '检测到旧版本地数据，正在上传到服务端登记（只读，不影响新刮卡）…'
  const result = await migration.run()
  if (result.ok) {
    migrationOverlay.hidden = true
    const revealed = result.imported?.revealed?.length ?? 0
    const claimed = result.imported?.claimed?.length ?? 0
    if (revealed + claimed > 0) {
      notify(`历史记录迁移完成：${claimed} 条已领取、${revealed} 条待领取`)
    }
    return true
  }
  migrationDesc.textContent = '迁移未完成（网络或服务端不可用）。历史数据已保留，不会丢失；恢复网络后请重试。'
  migrationRetry.hidden = false
  return false
}

function waitForMigrationRetry() {
  return new Promise((resolve) => {
    let settled = false
    const onClick = () => finish()
    // 多标签页：另一标签页完成导入删除旧 key 后，本页凭 storage 事件自动解除
    // （不读取事件内容，只重新检测 + 走服务端对齐）
    const onStorage = (event) => {
      if (
        typeof event?.key === 'string' &&
        (event.key === 'scratch-campaign-v1' || event.key.startsWith('scratch-campaign:v2:'))
      ) {
        finish()
      }
    }
    function finish() {
      if (settled) return
      settled = true
      migrationRetry.removeEventListener('click', onClick)
      window.removeEventListener?.('storage', onStorage)
      resolve()
    }
    migrationRetry.addEventListener('click', onClick)
    window.addEventListener?.('storage', onStorage)
  })
}

async function main() {
  storageHint.hidden = cache.isPersistent

  // 1) 会话 + 全量公开视图（迁移也需要会话 cookie）；失败则准备离线只读
  let fullView = null
  try {
    fullView = await ensureSession()
  } catch {
    fullView = null
  }

  // 2) 迁移向导：检测到旧 key 时页面只读锁定。
  //    离线导致无法迁移时同样锁定并保留旧数据，恢复后重试；绝不本地开奖兜底。
  if (migration.detectLegacy().length > 0) {
    let migrated = false
    while (!migrated) {
      if (!fullView) {
        migrationOverlay.hidden = false
        migrationRetry.hidden = false
        migrationDesc.textContent = '网络不可用，暂时无法迁移历史记录。旧数据已保留，恢复网络后请重试。'
        await waitForMigrationRetry()
        try {
          fullView = await ensureSession()
        } catch {
          fullView = null
        }
        if (!fullView) continue
      }
      migrated = await runMigrationIfNeeded()
      if (!migrated) {
        await waitForMigrationRetry()
        try {
          fullView = await ensureSession()
        } catch {
          // 保持离线锁定
        }
      }
    }
    // 导入的待领卡已进入服务端账本：重新拉取对齐
    try {
      fullView = await ensureSession()
    } catch {
      // 迁移已成功但临时不可达：用离线缓存只读呈现
      fullView = null
    }
  }

  // 3) 渲染两个相互隔离的活动
  const root = document.querySelector('#campaigns')
  for (const meta of CAMPAIGNS_META) {
    const sessionMeta = fullView
      ? fullView.campaigns.find((item) => item.campaignId === meta.id)
      : cache.loadSessionMeta()?.campaigns?.find((item) => item.campaignId === meta.id)
    const cardIds = sessionMeta?.cardIds ?? []
    const controller = createCampaignController({
      campaignId: meta.id,
      cardIds,
      api,
      cache,
      dirtyChannel,
      online: Boolean(fullView),
    })
    if (fullView) controller.hydrate(fullView)
    else controller.hydrateOffline()
    controllers.set(meta.id, controller)
    root.appendChild(buildCampaignSection(meta, controller))
  }

  updateOfflineBanner()

  // 回前台与低频轮询：只拉服务端公开视图（跨天/他页领取兜底）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshAll()
  })
  setInterval(() => {
    void refreshAll()
  }, POLL_INTERVAL_MS)
}

main()

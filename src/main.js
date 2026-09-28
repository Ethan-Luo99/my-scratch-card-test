/**
 * 页面装配层：服务端权威前端。
 *
 * 启动顺序：会话（cookie）-> 旧数据迁移向导（锁定/上传/清理）->
 * GET /api/state 镜像 -> 渲染。任何阶段服务端不可达都进入只读/锁定，
 * 绝不本地摇奖。
 *
 * 本文件只做装配与展示，不实现任何业务规则；公平性面板仅引用揭晓后
 * 的只读复核模块与公开权重表。
 */
import './style.css'
import { createKvBackend } from './storage/backend.js'
import { createDirtyChannel, createLockManager, createSenderId } from './storage/sync.js'
import { createCacheStore } from './storage/cache.js'
import { createApiClient, ApiError } from './api/client.js'
import { createCampaign } from './campaign.js'
import { createScratchCard } from './card.js'
import { runMigration, detectLegacyKeys } from './lib/legacy.js'
import { verifyCard } from './lib/verify.js'
import { getPublicWeights } from './lib/public-weights.js'

const backend = createKvBackend()
const locks = createLockManager()
const senderId = createSenderId()
const cache = createCacheStore(backend)
// 会话 cookie 过期/丢失：自动重建会话后原样重试一次（幂等键不变，不重复扣费）
const api = createApiClient({
  onUnauthorized: () => api.createSession(),
})

const app = document.querySelector('#app')

app.innerHTML = `
  <header class="site-header">
    <h1>幸运刮刮卡</h1>
    <p class="subtitle">服务端权威开奖 · 先承诺后揭晓 · 多活动同台</p>
    <p class="offline-banner" id="offline-banner" hidden>
      ⚠️ 服务端不可用：当前为只读模式，已揭晓内容可离线查看，刮卡与领取已暂停
    </p>
    <p class="storage-hint" id="storage-hint" hidden>
      当前环境不支持本地存储：在线可正常使用，但无离线缓存，刷新后仅恢复服务端状态
    </p>
    <div class="migration-panel" id="migration-panel" hidden>
      <h2>正在迁移历史记录</h2>
      <p id="migration-text">检测到本机旧版刮卡记录，迁移完成前暂时无法开始新刮卡。</p>
      <button type="button" class="btn-primary" id="migration-retry" hidden>重试迁移</button>
    </div>
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
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`

const offlineBanner = app.querySelector('#offline-banner')
const storageHint = app.querySelector('#storage-hint')
const migrationPanel = app.querySelector('#migration-panel')
const migrationText = app.querySelector('#migration-text')
const migrationRetry = app.querySelector('#migration-retry')
const modal = app.querySelector('#modal')
const modalTitle = app.querySelector('#modal-title')
const modalDesc = app.querySelector('#modal-desc')
const modalClaim = app.querySelector('#modal-claim')
const modalClose = app.querySelector('#modal-close')
const verifyToggle = app.querySelector('#verify-toggle')
const verifyPanel = app.querySelector('#verify-panel')
const toast = app.querySelector('#toast')

let toastTimer = null
function notify(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800)
}

const instances = new Map()
let modalCampaignId = null
let modalCardId = null
let verificationKeyCache = null

function openResultModal(campaignId, cardId) {
  const campaign = instances.get(campaignId)
  const card = campaign?.getCard(cardId)
  // 门控：只有已揭晓（奖品已公开）才打开结果弹窗
  if (!card || !card.prize || (card.status !== 'revealed' && card.status !== 'claimed')) return
  modalCampaignId = campaignId
  modalCardId = cardId
  modalTitle.textContent = card.prize.win ? '🎉 恭喜中奖！' : '谢谢参与'
  modalDesc.textContent = card.prize.win
    ? `你获得了「${card.prize.name}」，领取后可在其他页面查看。`
    : '很遗憾这次没有中奖，明天再来试试手气吧。'
  modalClaim.textContent = card.status === 'claimed' ? '已领取' : card.prize.win ? '立即领取' : '知道了'
  modalClaim.disabled = card.status === 'claimed' || campaign.snapshot.offline
  // 公平性面板仅对已揭晓且带服务端回执的卡可用
  verifyToggle.hidden = !card.receipt
  verifyToggle.textContent = '🔍 公平性验证'
  verifyPanel.hidden = true
  verifyPanel.innerHTML = ''
  modal.hidden = false
  if (!modalClaim.disabled) modalClaim.focus()
}

function closeModal() {
  modal.hidden = true
  modalCampaignId = null
  modalCardId = null
}

modalClaim.addEventListener('click', async () => {
  if (!modalCampaignId) {
    closeModal()
    return
  }
  const campaign = instances.get(modalCampaignId)
  const card = campaign.getCard(modalCardId)
  if (card.status === 'claimed') {
    closeModal()
    return
  }
  modalClaim.disabled = true
  try {
    const result = await campaign.claim(modalCardId)
    if (!result.ok) {
      if (result.reason === 'already-claimed') {
        notify('该奖品已在其他标签页被领取（先到先得）')
      }
      closeModal()
      return
    }
    if (card.prize?.win) notify('领取成功，可在"我的奖品"中查看')
    closeModal()
  } catch {
    modalClaim.disabled = false
    notify('网络不给力，领取失败，可重试（不会重复领取）')
  }
})

modalClose.addEventListener('click', closeModal)
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modal.hidden) closeModal()
})

async function getVerificationKey() {
  if (verificationKeyCache) return verificationKeyCache
  const cached = cache.loadVerificationKey()
  if (cached) {
    verificationKeyCache = cached
    return cached
  }
  const info = await api.verificationKey()
  cache.saveVerificationKey(info)
  verificationKeyCache = info
  return info
}

verifyToggle.addEventListener('click', async () => {
  if (!modalCampaignId || !modalCardId) return
  const campaign = instances.get(modalCampaignId)
  const card = campaign.getCard(modalCardId)
  if (!card?.receipt) return

  verifyPanel.hidden = false
  verifyPanel.textContent = '核验中…'
  verifyToggle.disabled = true

  let publicKeyHex = null
  try {
    const keyInfo = await getVerificationKey()
    publicKeyHex = keyInfo.publicKeyHex
  } catch {
    publicKeyHex = cache.loadVerificationKey()?.publicKeyHex ?? null
  }
  const weights = getPublicWeights(modalCampaignId, card.receipt.weightsVersion)
  const report = await verifyCard({
    card,
    campaignId: modalCampaignId,
    weights,
    commitment: campaign.getCommitment(card.cardId)?.commitment ?? card.receipt.commitment,
    publicKeyHex,
  })

  verifyToggle.disabled = false
  verifyToggle.textContent = '✅ 已验证'
  if (!report.available) {
    verifyPanel.textContent = report.note ?? '该卡无服务端凭证，不参与密码学复核。'
    return
  }
  verifyPanel.innerHTML = `
    <dl>
      <dt>随机种子 seedHex</dt><dd class="mono">${report.seedHex}</dd>
      <dt>权重版本</dt><dd>${report.weightsVersion ?? '—'}</dd>
      <dt>承诺 SHA-256 复核</dt><dd>${formatCheck(report.commitmentMatches)}</dd>
      <dt>服务端签名验签</dt><dd>${formatCheck(report.signatureValid)}</dd>
      <dt>公开权重重算奖品</dt><dd>${report.redraw ? report.redraw.name : '—'}</dd>
      <dt>结果核对</dt><dd>${formatCheck(report.prizeMatches)}</dd>
    </dl>
    <p class="verify-note">开奖结果在你刮开涂层前就已由服务端固定（SHA-256 承诺先行），
      揭晓后凭 seedHex 可重算承诺、校验 Ed25519 签名并按公开权重复放同一结果。</p>
  `
})

function formatCheck(value) {
  if (value === null || value === undefined) return '— 无缓存数据'
  return value ? '✅ 一致' : '❌ 不一致'
}

function renderCampaignSection(campaign, meta) {
  const section = document.createElement('section')
  section.className = 'campaign'
  section.dataset.campaignId = campaign.id
  section.dataset.theme = campaign.id === 'weekend' ? 'weekend' : 'daily'
  section.innerHTML = `
    <div class="campaign-head">
      <h2>${meta.title}</h2>
      <p class="campaign-sub">${meta.subtitle ?? ''}</p>
      <p class="chances" aria-live="polite"></p>
      <p class="time-anomaly" hidden>⚠️ 检测到服务端时间异常，今日次数与状态继续沿用</p>
    </div>
    <div class="cards"></div>
  `
  const chancesEl = section.querySelector('.chances')
  const anomalyEl = section.querySelector('.time-anomaly')
  const grid = section.querySelector('.cards')

  const cards = campaign.cardIds.map((cardId) =>
    createScratchCard({
      id: cardId,
      campaign,
      notify,
      onRevealed: (cid) => openResultModal(campaign.id, cid),
    }),
  )
  for (const card of cards) grid.appendChild(card.el)

  campaign.onChange((snapshot) => {
    chancesEl.textContent = `今日剩余次数：${snapshot.chancesLeft} / ${snapshot.dailyChances}`
    chancesEl.classList.toggle('is-empty', snapshot.chancesLeft === 0)
    anomalyEl.hidden = !snapshot.clockAnomaly
    offlineBanner.hidden = !snapshot.offline
    for (const card of cards) card.update()
  })
  return section
}

function showMigrationPanel(detail, { retryable = false } = {}) {
  migrationPanel.hidden = false
  migrationText.textContent = detail
  migrationRetry.hidden = !retryable
}

let bootstrapOnline = null

async function withBootstrapSession(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await api.createSession()
      return operation()
    }
    throw error
  }
}

async function ensureSession() {
  try {
    await withBootstrapSession(() => api.health())
    bootstrapOnline = true
    return
  } catch {
    // 服务端不可达：进入只读/锁定引导，不创建会话、不本地开奖
  }
  bootstrapOnline = false
}

async function handleMigration() {
  const legacyKeys = detectLegacyKeys(backend)
  if (legacyKeys.length === 0) return false
  showMigrationPanel('检测到本机旧版刮卡记录，正在安全迁移：历史中奖会登记到服务端，迁移完成前无法开始新刮卡。')
  const outcome = await withBootstrapSession(() =>
    runMigration({
      backend,
      locks,
      importFn: (payload, payloadHash, idempotencyKey) =>
        api.migrateImport(payload, payloadHash, idempotencyKey),
    }),
  )
  if (outcome.migrated) {
    migrationPanel.hidden = true
    notify('历史记录迁移完成')
    return true
  }
  // 失败：旧 key 保留，页面锁定，可重试；绝不本地开奖兜底
  showMigrationPanel('迁移失败（网络或服务端不可用），历史数据已保留，恢复后请重试。', { retryable: true })
  return false
}

async function bootstrap() {
  storageHint.hidden = backend.isPersistent

  await ensureSession()
  if (!bootstrapOnline) {
    // 服务端不可达：只读/锁定，展示缓存的已揭晓内容，不迁移、不开始新刮卡
    offlineBanner.hidden = false
    showMigrationPanel('服务端不可用，暂时无法校验与迁移历史记录，恢复网络后自动继续。', { retryable: false })
    await renderOfflineFallback()
    scheduleRecovery()
    return
  }

  const migrated = await handleMigration()
  if (!migrated && detectLegacyKeys(backend).length > 0) {
    migrationRetry.addEventListener(
      'click',
      async () => {
        migrationRetry.disabled = true
        await bootstrap()
        migrationRetry.disabled = false
      },
      { once: true },
    )
    return
  }

  const root = document.querySelector('#campaigns')
  const recoverView = await withBootstrapSession(() => api.recover())
  mountFromView(recoverView, root)
}

/** 离线启动后的自动恢复：网络回来后重新走完整引导（含迁移） */
function scheduleRecovery() {
  const tryRecover = () => {
    instances.forEach((campaign) => campaign.destroy())
    instances.clear()
    document.querySelector('#campaigns').textContent = ''
    migrationPanel.hidden = true
    void bootstrap()
  }
  window.addEventListener('online', tryRecover, { once: true })
  const timer = setInterval(() => {
    api
      .health()
      .then(() => {
        clearInterval(timer)
        tryRecover()
      })
      .catch(() => {})
  }, 8000)
  if (typeof timer.unref === 'function') timer.unref()
}

function mountFromView(view, root) {
  root.textContent = ''
  for (const campaignView of view.campaigns) {
    const dirtyChannel = createDirtyChannel({
      name: `scratch-card:dirty:${campaignView.campaignId}`,
      backend,
      senderId,
    })
    const campaign = createCampaign({
      id: campaignView.campaignId,
      title: campaignView.title,
      cardIds: campaignView.cardIds ?? campaignView.cards.map((card) => card.cardId),
      dailyChances: campaignView.dailyChances,
      api,
      cache,
      dirtyChannel,
    })
    instances.set(campaignView.campaignId, campaign)
    const section = renderCampaignSection(campaign, campaignView)
    root.appendChild(section)
    // recover 响应含全部活动视图，按活动切片作首帧注入，避免重复请求
    void campaign.init({
      serverTime: view.serverTime,
      day: view.day,
      clockAnomaly: view.clockAnomaly,
      campaigns: [campaignView],
    })
  }
}

async function renderOfflineFallback() {
  const root = document.querySelector('#campaigns')
  root.textContent = ''
  const revealed = cache.loadRevealedCards()
  const byCampaign = new Map()
  for (const card of Object.values(revealed)) {
    const list = byCampaign.get(card.campaignId) ?? []
    list.push(card)
    byCampaign.set(card.campaignId, list)
  }
  const knownCardIds = (campaignId) =>
    campaignId === 'weekend'
      ? ['weekend-1', 'weekend-2', 'weekend-3', 'weekend-4']
      : ['daily-1', 'daily-2', 'daily-3']
  for (const [campaignId, cardsView] of byCampaign) {
    const campaign = createCampaign({
      id: campaignId,
      title: campaignId === 'weekend' ? '周末狂欢卡' : '每日刮刮卡',
      cardIds: knownCardIds(campaignId),
      dailyChances: campaignId === 'weekend' ? 5 : 3,
      api,
      cache,
      dirtyChannel: null,
    })
    instances.set(campaignId, campaign)
    const section = renderCampaignSection(campaign, {
      title: campaignId === 'weekend' ? '周末狂欢卡' : '每日刮刮卡',
      subtitle: '离线只读：仅展示已揭晓内容',
    })
    root.appendChild(section)
    // 离线首帧：未揭晓槽位全部 idle、剩余次数显示 0（不臆造次数），
    // 已揭晓卡由 init 内的缓存注水只读展示
    await campaign.init({
      campaigns: [
        {
          campaignId,
          title: campaignId === 'weekend' ? '周末狂欢卡' : '每日刮刮卡',
          dailyChances: campaignId === 'weekend' ? 5 : 3,
          chancesLeft: 0,
          cards: cardsView,
        },
      ],
    }, { forceOffline: true })
  }
}

bootstrap().catch((error) => {
  offlineBanner.hidden = false
  showMigrationPanel('初始化失败，请检查网络后刷新页面。', { retryable: false })
  console.error('bootstrap failed', error)
})

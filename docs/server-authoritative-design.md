# 幸运刮刮卡 · Server-Authoritative 安全改造设计文档

> 范围：仅设计，不改实现。本文所有"现状"结论均给出 `文件:行号` 证据；行号基于
> 当前工作树（Vite + 原生 JS）。方案目标：**结果永远不提前抵达客户端**——未揭晓
> 卡片的 seed / 奖品，不出现在 localStorage、DOM、网络响应、JS 内存中的任何一处；
> 开奖由前端无法读取内部状态的"服务端"完成。

---

## 1. 现状审计

### 1.1 关键事实：开奖在 begin，不在 reveal

当前"刮开"是纯前端本地行为，奖品在用户**第一次落下笔画（begin）时就已在本机摇出**，
`reveal` 只翻转本地状态、不引入任何新信息：

- `src/card.js:64-75`：`onStrokeStart` 调用 `campaign.beginScratch(id)`，这是刮擦被
  授权的时刻。
- `src/campaign.js:326-341`：`beginScratch` 内先 `generateSeedFn()` 本地生成 seed，
  再进入锁内迁移。
- `src/lib/state-machine.js:172-179`：首次 begin 的迁移中一次性完成
  `chancesUsed += 1`、`card.seed = seed`、`card.prize = drawPrize(prizes, seed)`、
  `card.seedHash = fnv1aHex(...)`。
- `src/lib/randomness.js:49-54`：`drawPrize` 用 `mulberry32(seed)` 按权重确定性摇奖。
- `src/campaign.js:343-350` 与 `src/lib/state-machine.js:185-194`：`reveal` 仅把
  `scratching -> revealed`，不摇奖、不联网。

结论：安全语义上的"未揭晓"是 begin 之后、reveal 之前这段时间——但结果在此区间
**已经完整存在于客户端**。

### 1.2 seed / prize / seedHash 的完整数据流

**生成（纯前端）**

- `src/lib/randomness.js:57-72`：`generateSeed` 优先
  `crypto.getRandomValues(Uint32Array(1))`，取 32 位无符号整数；crypto 不可用时用
  `performance.now()/Date.now()` + 进程内计数器做 FNV 风格混合兜底。
- 调用点：`src/campaign.js:327`（seed 在进入 Web Lock **之前**就已生成于调用栈；
  注释 `src/campaign.js:322-325` 自称"锁内迁移时才生成"，与实现存在出入）。
- 摇奖与哈希：`src/lib/state-machine.js:176-178`，seed、prize、seedHash 在同一次
  纯迁移里产生。

**落盘（明文 localStorage）**

- 写路径：`src/campaign.js:184-230` 的 `commitTransition` →
  `casWrite`（`src/campaign.js:129-163`）→ `JSON.stringify(envelope)` →
  `backend.setItem(key, raw)`（`src/campaign.js:159`、`src/storage/backend.js:59-73`）。
- key：`scratch-campaign:v2:<campaignId>`，见 `src/main.js:170`。
- 信封明文结构含 `state.cards[id].{seed, seedHash, prize:{name,win}}`，字段注释见
  `src/lib/migration.js:255-267`；持久化字段见 `src/lib/state-machine.js:118-120`
  （`freshCard`）与 `:241-247`（sanitize 会把外部数据中的 seed/prize 原样接回）。
- 只要用户对一张卡 begin 过（哪怕没刮够 60%、没 reveal、刷新过），seed 与奖品名就
  以明文躺在 localStorage，直到跨天 reset（`src/lib/state-machine.js:141-154`）。
- 刷新恢复不清除结果：`src/lib/state-machine.js:212-224` 把残留 `scratching` 回退为
  `idle`，注释明确"chanceSpent / prize / seed 全部保留，不重扣不重摇"
  （`src/lib/state-machine.js:208-211`），由 `src/campaign.js:243-261` 落盘。

**DOM 渲染（涂层只是视觉遮盖，文本一直在 DOM 里）**

- 结构：`src/card.js:22-32`，`.prize-layer`（含 `.prize-result` / `.prize-name`
  两个文本 span）在下层，`.scratch-canvas` 在上层。
- CSS：`src/style.css:237-264`，两层均 `position:absolute; inset:0`，canvas 后绘制
  故视觉盖住奖品层；但 canvas 是位图涂层，**不改变 DOM 文本可达性**。
- 文本写入：`src/card.js:129-137`，只要 `card.prize` 非空（begin 后即为真），
  `update()` 就把 `card.prize.name` 写进 `.prize-name` 的 `textContent`。
  `update()` 在组件构造末尾立即执行（`src/card.js:155`），并在每次快照变更时由
  `src/main.js:229-235` 触发。因此：
  - begin 后、肉眼看到结果前，奖品名已在 DOM：DevTools 元素面板、`el.textContent`、
    屏幕阅读器、页内查找、阅读模式均可读到。
  - 页面首帧即会把历史已 begin 卡片（含刷新归一后的 idle 卡，`src/card.js:123-127`
    只复位涂层、不清 prize）的奖品名写入 DOM。
- 结果弹窗：`src/main.js:96-114` 直接读 `card.prize.name`；公平性面板把明文 seed
  直接渲染进 DOM：`src/main.js:155-165`（`${report.seed}`）。

**跨标签页流动（他页拉取整个明文信封）**

- 通道：`src/storage/sync.js:118-183`，优先 BroadcastChannel，降级 storage 事件。
- 广播内容只含 `{ rev }`（`src/storage/sync.js:164-172`），但接收方动作是
  **回 localStorage 拉整个信封**：`src/campaign.js:232-240` 的 `pullRemote()` →
  `readLatest()`（`src/campaign.js:65-122`）→ `backend.getItem(key)` → `JSON.parse`
  → `envelope = latest` → `emit('remote')` → 各卡 `update()` 渲染明文奖品。
- storage 事件兜底时，浏览器给出的 `event.newValue` 本身就是整份明文信封：
  `src/storage/backend.js:32-44`（`fn(event.key, event.newValue)`）；虽然 sync 只用
  key 做提示（`src/storage/sync.js:140-142`），明文仍随事件进入本页 JS 上下文。
- 他页 begin 后，本页即使一张卡都没刮，内存快照（`envelope`，`src/campaign.js:53`）
  与 DOM 中也已持有他页全部未揭晓卡的 seed/奖品。

**JS 内存**

- 闭包单例 `envelope` 持有全部卡片的 seed/prize：`src/campaign.js:53`，并在
  begin/reveal/claim/init/pullRemote 各路径被整体替换为最新明文
  （`src/campaign.js:211`、`:236`、`:254-262`）。
- seed 还存在于 `beginScratch` 的调用栈与 commit 选项对象：`src/campaign.js:327-336`。

### 1.3 现有机制与改造后的职责划分

| 机制 | 现状实现 | 现状问题 |
| --- | --- | --- |
| 可验证公平性 | seed 本地生成（`src/lib/randomness.js:57-72`）；事后展示 seed + FNV-1a，前端用同一 seed 重算 mulberry32 核对（`src/campaign.js:371-389`，UI `src/main.js:149-167`） | 承诺与结果同机产生、事前不下发；玩家自己选 seed，承诺无约束力；FNV-1a 非密码学哈希；承诺不绑定权重表/日期/卡面 |
| 锁 + CAS | Web Locks 串行 + `rev` 乐观锁，冲突重试 8 次（`src/campaign.js:129-163`、`:184-230`；锁 `src/storage/sync.js:209-242`） | 只保证多标签页本地写一致；信任根是可任意改写的 localStorage，防不住"本机玩家" |
| 时间回拨 | 本地时钟 `resolveDay`：回拨则沿用 lastDate、标 anomaly（`src/lib/time.js:401-421`；接入点 `src/campaign.js:106-121`、`:278-294`） | 跨天判定信任客户端时钟，改时钟/改存档日期即可重刷次数 |

- **收归服务端**：seed 生成与保存、摇奖、次数记账与扣减原子性、跨天/回拨判定、
  先到先得领取裁决、幂等与防重放、承诺签发与结果签名。
- **留在前端**：涂层渲染与 60% 覆盖率统计（纯表现，`src/coverage.js` 原样保留）、
  笔画缓冲/授权交互（`src/scratch-layer.js` 的 Promise-gate 模式）、结果动画、
  已公开结果的展示与只读缓存、对服务端回执的本地核对（验承诺/验签名/重算）、
  网络失败下的只读/锁定 UI。

---

## 2. 泄露面评级

评级维度：攻击者获得未揭晓结果 / 控制开奖结果所需的能力与成本。评级只针对当前实现。

| # | 泄露面 | 评级 | 证据 | 攻击成本与后果 |
| --- | --- | --- | --- | --- |
| L1 | localStorage 明文保存 seed / seedHash / 奖品名 | **严重** | 写入 `src/campaign.js:129-163`（`:159`）；字段 `src/lib/state-machine.js:118-120,176-178`；key `src/main.js:170` | DevTools Console / 浏览器扩展 / XSS / 配置文件同步备份均可直接读；begin 后立即可读，无需刮开。还可直接改写 `prize`/`chancesUsed`/`rev`，sanitize 会照单接收（`src/lib/state-machine.js:241-247`） |
| L2 | 未刮开时奖品文本已在 DOM | **高** | `src/card.js:129-137`（`:132` 写 prize.name）、`:155`；结构 `src/card.js:22-32`；涂层仅视觉遮盖 `src/style.css:266-277` | `document.querySelector('.prize-name').textContent` 一行可得；屏幕阅读器、页内查找、无障碍树同样可达。canvas 防的是"肉眼"，不防 DOM |
| L3 | 跨标签页同步把明文信封拉进他页 | **高** | `src/campaign.js:232-240` → `:65-122`（`getItem`+`JSON.parse`）；`event.newValue` 明文 `src/storage/backend.js:32-44` | 任一标签页 begin，所有同站标签页（哪怕没交互过）的内存与 DOM 均含未揭晓 seed/奖品；storage 监听是全局注册的（`src/main.js:45-47` 单例 backend） |
| L4 | 闭包内存持有全部未揭晓结果 | **中高** | `src/campaign.js:53`、`:211`、`:236`、`:327-336` | 需要页面上下文 JS 执行权（XSS / 恶意扩展 / DevTools）。属"前端必然能读到自己内存"的根因类问题，只能靠"内存里本来就没有"解决 |
| L5 | seed 32bit + FNV-1a 32bit，可离线穷举/选种 | **严重** | seed 空间 `src/lib/randomness.js:57-61`（Uint32Array(1)）；摇奖 `:49-54`、`src/lib/state-machine.js:177`；哈希 `:23-31`；权重表随包下发 `src/main.js:11-22` | 见下方量级测算：**选种（grinding）近乎零成本**；即使只有 hash，单核分钟级穷举 |
| L6 | crypto 不可用时的弱熵兜底 | **中** | `src/lib/randomness.js:63-71` | 时间+进程计数器混合，同环境内可预测/复现；放大 L5 |
| L7 | 无网络请求，结果不经网络 | 不适用 | 全仓无 fetch/XHR（`rg -n "fetch\(|XMLHttpRequest" src` 无命中） | 当前无网络泄露面；但权重表与算法在 JS bundle 内公开（`src/main.js:11-22`、`src/lib/randomness.js`），是 L5 的前提 |

### 2.1 L5 量级测算：32bit seed + FNV-1a 是否防得住离线穷举

**空间**：seed 是 uint32，仅 2^32 ≈ 4.29×10^9 个候选；FNV-1a 输出也是 32bit，
非密钥哈希、无盐（`src/lib/randomness.js:23-31`）。

**攻击 A——选种（grinding），最致命，且不需要哈希碰撞**：
seed 由客户端生成后客户端立刻本地摇奖（`src/campaign.js:327` →
`src/lib/state-machine.js:176-177`）。攻击者在 begin 前循环候选 seed：

- 每候选只需 1 次 mulberry32 步进（5 个 32 位运算，`src/lib/randomness.js:12-20`）
  + 一次权重区间比较（`src/lib/randomness.js:34-46`）。
- 命中率即奖品权重：每日 88 元红包 5/100 → 期望约 20 次；iPhone 券 2/100 →
  期望约 50 次；任意中奖（daily 权重和 30/100）期望约 3.3 次。
- 单核 JS 每秒可评估 10^7～10^8 个候选，**拿到一个目标中奖 seed 的期望耗时在
  微秒～毫秒级**。随后可直接走正常 begin 路径，或直接构造合法信封写入
  localStorage（L1），现有"公平性验证"反而会显示 ✅（因为 seed 确实能重放出该奖品）。

**攻击 B——只有 seedHash 时的原像穷举**：
FNV-1a(String(seed)) 每候选最多 10 个字符 × 一次乘异，单核约 10^7～10^9 次/秒，
全空间遍历量级 **数秒到数分钟**；且 FNV 无盐，2^32 的"seed→hash→奖品"映射表可
一次性预算（数十 GB 原始表，排序/哈希索引后更小），对所有用户、所有卡片复用。
32bit 输出还存在生日碰撞与多原像，承诺不具备密码学绑定性。

**攻击 C——直接篡改落盘结果**：
localStorage 完全可写，改 `prize.name/win`、`chancesUsed`、`rev` 即可
（迁移/清洗只做类型容错不做真实性校验，`src/lib/state-machine.js:227-259`）；
校验面板能发现"重算不一致"，但主流程 UI 与领取只信状态、不信校验
（`src/main.js:122-140`、`src/lib/state-machine.js:197-206`）。

**结论**：FNV-1a 32bit 在本机威胁模型下不提供任何有意义的安全边际；而真正的根因是
"客户端生成 seed 且客户端摇奖"——服务端化后，seed 空间、承诺算法、摇奖位置三者都
必须同时升级（详见 §5）。

---

## 3. 方案总览与 API 契约

### 3.1 架构总览（仅描述目标形态，本提交不创建这些文件）

```
浏览器（src/，现有代码的改造目标）
  └─ fetch('/api/...')  ── 真实 HTTP，禁止 import server/ 下任何模块
            │
Vite dev server（新增 vite.config.js，configureServer 中间件，零三方依赖）
            │
server/（新增，纯 ESM，只用 node: 内置模块：node:crypto / node:http / node:fs）
  ├─ http/   极薄 HTTP 适配：路由、JSON 编解码、鉴权头解析（dev 中间件与 node:http 生产入口共用）
  ├─ core/   纯领域逻辑：状态机、记账事务、幂等表、摇奖算法、承诺/签名、跨天
  └─ store/  存储接口 + 内存实现（测试用）+ 文件实现（dev 用，原子 rename）
test/server/（新增，node --test 直接 import server/core 与 server/store，不起 Vite）
```

硬边界（用测试断言固化，见 §9）：

- `src/**` 中任何模块不得静态或动态 `import` `server/**`；`server/**` 不得 import
  `src/**`。前端只通过 HTTP 触达服务端。
- `server/core` 不引用 `node:http`、不读请求头，可被 `node --test` 纯函数式测试；
  HTTP 语义只在 `server/http` 适配层做一次性集成测试（Vite dev server 中间件）。
- 不新增任何 npm 依赖（密码学全部使用 Node 内置 Web/`node:crypto`：SHA-256、
  HMAC、Ed25519、`crypto.randomBytes`、`crypto.randomUUID`）。
- `vite build` 只打包 `src/`；`vite.config.js` 与 `server/` 不进客户端 bundle
  （Vite 天然不打包 config，设计上再以目录隔离 + 测试断言兜底）。

**身份模型（无登录前提下的最大努力）**：客户端首次启动调用 `POST /api/register`
取得不透明玩家令牌 `playerToken`（服务端随机 256bit，仅存其 SHA-256 摘要），
存 localStorage，之后所有请求带 `Authorization: Bearer`。它能区分"同一浏览器的
同一玩家"以记账，不能证明真人身份；清除存储即可换身份（sybil 风险见 §9）。

**每日记账主键**：`(playerId, campaignId, dayKey)`，`dayKey` 由服务端按固定时区
（Asia/Shanghai，UTC+8，无夏令时）计算。

### 3.2 通用约定

- 请求/响应均为 JSON；除 register 外全部需要 `Authorization: Bearer <token>`。
- begin / settle / claim / recover 请求必须带幂等头
  `Idempotency-Key: <crypto.randomUUID()>`（客户端每次"用户意图"生成一个，
  重试沿用同一个；双标签页各自独立意图各自生成）。
- 错误响应统一为 `{ "ok": false, "code": "...", "message": "...", "serverTime", "dayKey" }`。
- 服务端每个响应都回 `serverTime`（ISO-8601）与 `dayKey`，仅供前端展示，前端不得
  用本地时钟做任何额度/跨天判定。
- **统一保密不变量**：服务端对状态为 `pending` 的局，任何接口（含 sync、错误回包、
  日志）都不得输出其 `serverSeed`、`roll`、`prize`、`prizeIndex`；`drawId` 为
  128bit 随机不透明 ID，**不得编码任何与结果相关的信息**。

### 3.3 `POST /api/register`（开始刮之前的一次性注册/找回）

请求：`{ "clientDeviceId": "<可选，localStorage 内 uuid>" }`
200：`{ "ok": true, "playerToken": "<256bit base64url>", "playerId": "<id>", "serverTime", "dayKey" }`
- 已有令牌不调用本接口；令牌丢失（换浏览器/清存储）无法找回旧身份与旧战绩。
- 幂等：携带 `clientDeviceId` 且服务端留有该设备映射时返回同一令牌（响应本身不含
  任何开奖信息，重放无害）。

### 3.4 `POST /api/campaigns/:campaignId/begin`（开始刮 / 占次）

请求体：`{ "clientSeed": "<可选，用户可改的字符串，缺省服务端记空串>", "scratchStyle": "manual|reveal-button" }`

服务端在**一个事务**内完成：校验活动与当日配置 → 校验/创建当日计数行 →
若 `used >= total` 拒绝 → `used += 1` → 生成 `serverSeed = crypto.randomBytes(32)`
→ `commitment = sha256(serverSeed)` → 建立 `pending` 局（slot 由服务端按 `used-1`
分配，客户端无权选卡面序号）→ 幂等记录落盘。

200：

```json
{
  "ok": true,
  "drawId": "D_<128bit base64url>",
  "campaignId": "daily",
  "slot": 0,
  "status": "pending",
  "commitment": "ab12…(sha256(serverSeed) hex)",
  "clientSeed": "用户提供值或空串",
  "nonce": "daily|2026-09-23|0",
  "algorithm": "hmac-sha256-weighted-v1",
  "manifestRef": "manifest-v3@<签名前8hex>",
  "chancesUsed": 1,
  "chancesTotal": 3,
  "dayKey": "2026-09-23",
  "expiresAt": "2026-09-24T00:00:00+08:00",
  "serverTime": "2026-09-23T12:00:00.000Z"
}
```

错误：`no-chances`（409，当日次数已尽，不建局不扣次）、`unknown-campaign`(404)、
`duplicate-draw-in-flight`(409，同一幂等键外若该 slot 已存在 pending 且客户端又用
新键 begin：正常允许——begin 即扣次，不允许"客户端用 begin 试探结果"，因为响应里
没有结果）、`day-rolled`(409，客户端 dayKey 过期，需先 sync)、`unauthorized`(401)。

**为什么 begin 响应只能含承诺，不能含 seed/奖品/seedHash-奖品关联物**：

1. begin 是"扣次 + 占局"点，settle 才是"揭晓授权"点。若 begin 给结果，结果在涂层
   被刮开前就抵达客户端，直接违反安全目标，重蹈 §1 覆辙。
2. 只给 `commitment = sha256(serverSeed)`：客户端事后可用 settle 回传的 seed 复算
   哈希，证明"种子在我开始刮之前就已固定"，但在揭晓前 hash 原像不可求（256bit，
   见 §5）。
3. `clientSeed` 混入摇奖，使服务端无法针对单个玩家的已知 serverSeed 定向出奖
   （serverSeed 在 begin 时才生成且承诺；配合 §5.3 的日前公开哈希链可进一步防
   "选种子"）。
4. 扣次与建局同事务且结果未知，从根上消灭 §2.1 攻击 A 的"免费选种重试"：重试一次
   就消耗一次真实配额，且选不到结果（seed 由服务端保密生成）。
5. 不返回 `prizeIndex`、不返回任何按奖品不同而不同的字段（包括缓存头/响应时序差异
   也应在 §9 测试中关注），杜绝侧信道编码。

### 3.5 `POST /api/draws/:drawId/settle`（结算 = 唯一开奖点）

请求体：`{ "clientSeed": "<必须与 begin 一致>", "coverage": 0.6 }`（coverage 仅作
遥测/审计，不影响结果，服务端不依赖它决定是否结算——"直接揭开"与刮满 60% 等价）。

服务端：校验令牌持有该 draw、状态为 `pending`、`dayKey` 仍为当日（跨天 pending 局
见 §4.5）→ 以保存的 `serverSeed` 与固定算法计算 `roll/prizeIndex`（§5.2）→
状态置 `revealed`、写 `prizeIndex/revealedAt` → 用 Ed25519 私钥对规范化载荷签名。

200：

```json
{
  "ok": true,
  "drawId": "D_…",
  "status": "revealed",
  "prize": { "id": "coupon-88", "name": "8.8元 优惠券", "win": true },
  "reveal": {
    "serverSeed": "<32B hex，本响应是 seed 唯一离开服务端的时刻>",
    "commitment": "ab12…（与 begin 一致）",
    "clientSeed": "",
    "nonce": "daily|2026-09-23|0",
    "roll": "0.31415926…",
    "prizeIndex": 2,
    "weightTableVersion": "manifest-v3",
    "algorithm": "hmac-sha256-weighted-v1"
  },
  "receipt": {
    "payload": "base64url(规范化 JSON：playerId,campaignId,dayKey,slot,prizeId,status,seq,serverTime)",
    "alg": "Ed25519",
    "kid": "scg-2026-09",
    "sig": "base64url…"
  },
  "dayKey": "2026-09-23",
  "serverTime": "…"
}
```

错误：`unknown-draw`(404)、`forbidden-owner`(403)、`invalid-state`(409，非 pending；
此时按幂等语义返回既有结果，见 §4.2)、`day-rolled`(409)、`commitment-mismatch`(409)。
重复 settle（网络重试、刷新后继续）携带同一幂等键：服务端返回**同一份** revealed
结果与同签名载荷——结果既已对该玩家揭晓，重放不构成提前泄露。

### 3.6 `POST /api/draws/:drawId/claim`（领取）

请求体：`{}` ＋ 幂等头。仅 `revealed → claimed`：

- 首次：CAS 式状态迁移，成功返回 `{ ok:true, status:"claimed", claimedAt, receipt }`
  （receipt 内容同上，`status:"claimed"`，`seq` 递增）。
- 同一幂等键重试：返回首次的 claimed 响应（幂等重放）。
- 双标签页用**不同**幂等键并发领取：一方成功；另一方得到
  `{ ok:false, code:"already-claimed" }`（先到先得由服务端裁决，前端现有
  "已在其他标签页被领取"提示语义保留，`src/main.js:130-132`）。
- 未中奖（`win:false`）也允许 claim（与现状"知道了"即结算一致，
  `src/main.js:126-128`），防止 revealed 长期悬挂。

### 3.7 `GET /api/sync?campaignId=:id`（同步：刷新恢复 / 跨标签页 / 重进）

返回服务端权威当日视图：

```json
{
  "ok": true,
  "campaignId": "daily",
  "dayKey": "2026-09-23",
  "chancesUsed": 2,
  "chancesTotal": 3,
  "serverTime": "…",
  "draws": [
    { "drawId": "D_1…", "slot": 0, "status": "claimed",
      "prize": { "id": "cash-88", "name": "88元 现金红包", "win": true },
      "claimedAt": "…", "receipt": { "…" } },
    { "drawId": "D_2…", "slot": 1, "status": "revealed",
      "prize": { "id": "thanks", "name": "谢谢参与", "win": false },
      "reveal": { "…同 settle，含 seed…" }, "receipt": { "…" } },
    { "drawId": "D_3…", "slot": 2, "status": "pending",
      "commitment": "ab12…", "clientSeed": "", "nonce": "daily|2026-09-23|2",
      "expiresAt": "…" }
  ]
}
```

铁律：`pending` 项只有 `{drawId, slot, status, commitment, clientSeed, nonce,
expiresAt}`；**没有 seed、没有 prize**。`revealed/claimed` 项才带奖品（已向该玩家
公开）。本接口取代现状中"他页回 localStorage 拉明文信封"的整条路径
（`src/campaign.js:232-240`）。另提供
`GET /api/draws/:drawId`（恢复单局：涂层刮到一半、请求丢失后的单局续作，字段裁剪
规则与 sync 完全一致）。

### 3.8 `POST /api/recover/legacy`（旧本地数据一次性迁移）

请求体：客户端从现有 localStorage（v1 key `scratch-campaign-v1`，
见 `src/lib/migration.js:277`；v2 key 见 `src/main.js:170`）读出并上传**迁移摘要**：

```json
{ "importBatchId": "<uuid>",
  "deviceMigrationNonce": "<uuid>",
  "records": [
    { "campaignId": "daily", "slot": 1, "legacyState": "revealed",
      "prize": { "name": "免费咖啡一杯", "win": true },
      "contentHash": "<sha256(规范化整条旧卡片记录 + 旧信封 rev)>",
      "localDayKey": "2026-09-23" }
  ] }
```

服务端规则（§7.3 详述）：

- 仅受理 cutover 日前产生的快照（以记录中可自证字段 + 宽限窗口约束，非密码学保证）；
- 奖品名必须命中服务端奖品目录白名单；导入中奖总数受每日次数与配置上限约束；
- `revealed` 未领取：生成服务端 `claimed?` 否——生成 `revealed` 记录并附
  `legacy:true` 标记，用户需走正常 claim，claim 时幂等去重；
- `idle/scratching`（已 begin 未刮开，含 seed/prize 的旧卡）：**丢弃本地 seed/prize**，
  该次机会由服务端判定为"未消费"（配额在新计数中不计 used）——宁可不续局，也绝不
  信任本地摇出的结果；
- 全局去重键：`sha256(canonical(legacy record))` 唯一约束，防止同一存档在不同设备
  重复导入（不同 playerId 也生效，对抗存档拷贝；变异存档的残余风险见 §9）；
- `importBatchId` 使整个迁移请求本身幂等。

---

## 4. 服务端设计

### 4.1 模块与存储

- `server/core/day.js`：服务端时钟 → dayKey（UTC+8）。提供
  `dayKeyFor(dateMs)` / `rollover(prev, now)` 纯函数，时钟可注入以便单测。
- `server/core/draw.js`：纯函数摇奖 `computeOutcome({serverSeed, clientSeed, nonce,
  manifest}) → {roll, prizeIndex}`（§5.2）；状态机 `pending → revealed → claimed`
  的合法迁移与错误码。
- `server/core/service.js`：用例编排（register/begin/settle/claim/sync/recover），
  只依赖一个 `Store` 接口；不接触 `node:http`，因此中间件与
  `node --test` 调用的是同一份逻辑。
- `server/core/commitment.js`：SHA-256 承诺、Ed25519 签名与规范化（canonical JSON：
  键排序、无多余空白），密钥句柄注入。
- `server/store/memory.js`：Map 实现（默认，测试与无盘环境用）；
  `server/store/file.js`：每玩家一文件或追加日志 + 快照，写入
  `tmp → fsync → rename` 原子替换；读取崩溃文件按"上一个完整快照 + 已 fsync 日志"
  恢复。
- `server/http/*`：dev 中间件（`vite.config.js` 的 `configureServer`）与可选的
  `node server/http/standalone.js` 生产入口共用的极薄路由层。

Store 最小接口：`getPlayer(id)`、`upsertPlayer`、`getDay(playerId, campaignId,
dayKey)`、`mutateDay(key, fn)`（在事务回调内完成读改写）、`putDraw/getDraw`、
`idempotencyLookup/put`、`hasLegacyHash/putLegacyHash`。

### 4.2 幂等与防重放

幂等表记录 `(playerId, idempotencyKey) → {method, path, requestHash,
responseSnapshot, createdAt, dayKey}`，TTL 覆盖至少 2 个结算日（建议 7 天，保证跨天
重试仍命中）。

| 场景 | 服务端行为 |
| --- | --- |
| 重复 begin（同幂等键，网络重试） | 不二次扣次、不新建局；返回第一次的 pending 局（或其当前状态的视图：若已 settle 则返回当前状态 + 提示 `advanced`，字段裁剪仍按状态保密） |
| begin 后换"新意图"再 begin | 正常扣次新建局（begin 即消费一次真实配额），杜绝零成本探测 |
| settle 重试 | pending 则完成开奖；已 revealed/claimed 则返回缓存的首次响应（含同一 receipt，`seq` 不变） |
| claim 重试 | 已 claimed 返回首次成功响应；不同键的竞争方返回 `already-claimed` |
| 同键不同请求体 | `idempotency-conflict`(422)，不执行（防幂等键复用混淆） |
| 重放他人令牌 / 跨玩家 drawId | `forbidden-owner`(403)；drawId 128bit 随机，不可枚举 |
| 回放旧请求攻击（无状态代理） | 幂等表 + 令牌摘要校验 + 过期 TTL 三重拦截；所有写操作仅认 POST + JSON，拒绝 GET 触发状态变更 |

### 4.3 次数记账原子性与双页并发

- 单节点中间件内为每个 `(playerId, campaignId, dayKey)` 维护一把异步互斥锁
  （Promise 链即可，类比前端现有 `withLocalMutex`，`src/storage/sync.js:212-224`）。
  begin/settle/claim/recover 对同一计数行的所有读改写都在锁内完成。
- 锁只是优化；正确性落在 Store 事务的条件写：`begin` 的提交条件是
  `day.used === 读入时的 used 且 used < total`，`claim` 的提交条件是
  `draw.status === 'revealed'`。条件不满足即冲突返回，调用方读到的就是裁决结果。
- 双标签页同时 begin：两个请求串行化，计数 `1,2` 或 `2,1`，其中一方在第 N+1 次拿到
  `no-chances`；不存在超发。双标签页同时 claim：一方 200，一方
  `already-claimed`。
- 多进程/多机部署超出本方案范围（中间件单进程）；Store 接口保留升级为
  带行锁/版本号存储的余地（条件写条件不变）。

### 4.4 以服务端时钟为准的跨天与回拨

- dayKey 只由服务端系统时钟按 UTC+8 推导，客户端的 `Date` 仅用于 UI 倒计时展示。
- 计数器以 dayKey 为行键惰性创建：第一次 begin 当日时建行；不存在"客户端触发跨天
  写入"。sync 返回服务端 dayKey，前端发现与本地缓存不符即整体切换视图。
- 服务端时钟回拨：
  - 回拨仍落在同一 dayKey：天然无影响（时钟只用于算 key 与 expiresAt）。
  - 回拨到更早日期：**绝不复活旧计数行**。规则取 `max(最近成功确认的 dayKey,
    当前计算 dayKey)` 作为有效日（持久化一个 `maxObservedDayKey` 单调值）；回拨日
    的 begin 一律按 `day-rolled` 处理并告警，防止运维改服务器时间重发额度。
  - 跨天前进：新 dayKey 新计数行，额度自动恢复，不依赖任何客户端在线动作
    （移除前端 60s rollover 轮询，`src/campaign.js:278-294` 的职责删除）。
- 开奖有效性以"begin 时签发的 dayKey"为准；中奖领取宽限：revealed 中奖在次日
  24:00（UTC+8）前仍可 claim，sync 中以 `claimableUntil` 明示。

### 4.5 seed 的存储与销毁时机

- 生成：仅在 begin 事务内 `crypto.randomBytes(32)`；生成后立即进入 pending draw
  记录（内存/文件），同事务写 commit。不写日志、不进任何错误消息。
- 保存：pending/revealed 期间以明文存于服务端记录（dev 文件存储的访问控制见 §8）；
  settle 后 seed 随 reveal 副本保存（用于事后重验/补发票据），保留期建议 90 天审计
  窗口，到期由清理任务物理删除（文件实现中重写记录；内存实现 delete）。
- 销毁/失效：
  - 跨天未 settle 的 pending 局：rollover 清理任务（下次该玩家请求或定时器触发）
    将其标记 `expired`，**销毁 serverSeed**，响应中仅保留
    `{status:"expired", commitment}`（已消费的次数不退还，行为对客户端透明：刮到一半
    跨天再来，sync 告知 expired）。销毁 seed 使承诺永不出现在一个"可被提前打开"的
    局上，也防止服务端长期滞留可用种子。
  - claim 完成不立即销毁（需留作争议重验），按保留期统一清理。
  - 任何删除路径都不得先把 seed 同步到客户端：expired 局永无 settle，seed 对客户端
    永远不可见。
- 服务端进程日志、错误堆栈中间件必须过滤 draw 记录；§9 有"日志/错误响应不含 seed"
  的断言。

---

## 5. 公平性重构：客户端不能复算开奖后，如何保留"可验证"

思路从"客户端自证"（同机生成 seed 再展示）升级为标准 **承诺-揭示 + 混合种子 +
签名回执** 三段式。可信对象从"本地代码"变为"事前承诺 + 事后可复核的数学关系 +
服务端签名"。注意：这提供的是**可审计性**，不是强迫服务端诚实（见 §8）。

### 5.1 协议时序

1. （可选增强）服务端在每个自然日开始前，对当日全部 slot 预生成 serverSeed 并只
   公开其哈希链根；基础版不做日前发布，仅做逐局承诺（见 5.3 取舍）。
2. `begin`：服务端生成 `serverSeed_s`（32B CSPRNG），返回
   `commitment = lowercase(hex(sha256(serverSeed_s)))`；客户端可提交/修改
   `clientSeed_c`（默认空串；UI 可提供"换一个我的种子"输入框）。承诺先于用户看到
   结果到达客户端，可保存/截图。
3. 用户刮卡（纯表现，不触发任何结果数据下发）。
4. `settle`：服务端公开 `serverSeed_s`、`roll`、中奖下标与签名回执——这是结果与
   seed 第一次、也是唯一一次到达客户端。
5. 客户端本地核对（用浏览器 WebCrypto，全部可离线完成）。

### 5.2 摇奖算法（版本化：`hmac-sha256-weighted-v1`）

```
msg      = UTF8(nonce) || 0x00 || UTF8(clientSeed)
mac      = HMAC_SHA256(key = serverSeed, msg = msg)
roll     = (bigint.fromBytes_be(mac) * 10^6) / 2^256 / 10^6      // [0,1)，6 位小数
prizeIndex = 权重区间定位：weights 顺序为 manifest 中固定顺序，
             roll 落入 [cumPrev/total, cumNext/total) 即对应下标（与现有
             drawPrizeIndex 的区间语义一致，src/lib/randomness.js:34-46）
```

- `nonce = campaignId | dayKey | slot`（如 `daily|2026-09-23|0`），保证同 seed
  不同局结果独立，也把结果绑定到具体活动/日期/卡位。
- 权重表来自服务端签名的 **manifest**，不再以 bundle 内 `DAILY_PRIZES`
  （`src/main.js:11-22`）为裁决依据；前端只保留展示用副本。
- `manifest = { version:"manifest-v3", campaigns: { daily: { total:3,
  prizes:[{id,name,win,weight}] }, weekend: {...} }, publishedAt, expiresAt }`，
  `GET /api/manifest/active` 返回该对象与 Ed25519 签名（kid 同回执）。签名权重表让
  "服务端临时改概率"可被事后发现（玩家持有的 reveal 记录里带 weightTableVersion）。

### 5.3 客户端核对步骤（settle / sync revealed 之后）

1. `sha256(serverSeed)` 等于 begin 时保存的 `commitment`（hex 小写严格相等）。
2. 用 `serverSeed / clientSeed / nonce` 本地执行 v1 算法，重算 `roll`、`prizeIndex`，
   与响应一致；`manifest.campaigns[campaignId].prizes[index]` 与响应 `prize` 的
   id/name/win 一致。
3. 用 `kid` 对应公钥（`GET /api/keys/:kid`，公钥可带在 app 内作钉扎）验证
   `receipt.sig` 覆盖 canonical payload；payload 字段含
   `playerId, campaignId, dayKey, slot, prizeId, status, seq, serverTime`，逐项与
   实际响应一致。
4. 三项全绿才展示"✅ 已验证"；任一失败显示"验证失败，请勿领取/请联系客服"，并保留
   原始响应供申诉。验证失败不影响服务端裁决（服务端不接受客户端"验证结果"）。

增强版（日前哈希链，写进设计但列为可选）：服务端对每天每活动预生成 N 个 seed
`s_0..s_{N-1}`，公开 `commitRoot = sha256(h(s_{N-1}) ‖ … ‖ h(s_0))`（或 Merkle 根
+ 公布 leaf 序号）。它防的是"服务端为特定玩家在 begin 时现选一个有利 seed"：
serverSeed 在玩家身份/请求产生之前就固定。代价是 dev 文件存储要预生成、slot 数量
受限（与每日 total 相等，天然匹配）。基础版承诺已能防"开奖后改 seed"，选种子风险
靠 clientSeed 混合 + 可审计日志缓解；是否启用由产品决定，接口中以
`commitmentScheme: "per-draw" | "day-chain"` 明示。

### 5.4 与旧实现的安全差距

- seed 32bit → 256bit：离线穷举从"分钟级"变为 2^256，不可行（对比 §2.1 攻击 B）。
- FNV-1a → SHA-256/HMAC：获得抗原像/抗碰撞与密钥分离；承诺不再可被预计算表攻击。
- 承诺事前下发：绑定"begin 时已定型"，而非开奖后自说自话（旧面板
  `src/main.js:155-165` 只能证明算法自洽，不能证明时机）。
- 权重表签名：开奖规则本身成为承诺的一部分（旧实现权重表可被前端/中间人版本替换且
  无校验）。
- 结果绑定玩家/日期/卡位并签名：reveal 回执不能被搬到别的账号或别的日期使用。

---

## 6. 前端改造（只描述设计）

### 6.1 卡片状态机（服务端权威）

前端单卡状态只镜像服务端，去掉本地 seed/prize 字段：

```
idle ──begin ok──▶ pending ──settle ok──▶ revealed ──claim ok──▶ claimed
 ▲                   │                        │
 │      begin/settle/claim 请求中：busy（涂层禁止新笔画，复用现有
 │      Promise-gate，src/scratch-layer.js:301-367）
 └────────────────── sync 跨天 / expired：回到 idle（新一天新 slot）
```

- `idle`：无任何局引用。
- `pending`：仅持有 `{ drawId, slot, commitment, clientSeed, nonce, expiresAt }`；
  内存中**没有** prize/serverSeed。笔画授权点改为调 begin（沿用
  `onStrokeStart` 门控，`src/card.js:64-75`）；达到 60% 阈值
  （`src/card.js:76-81`）或点"直接揭开"（`src/card.js:100-113`）时调 settle；
  settle 返回前涂层可继续显示刮痕动画，但不淡出、不弹窗。
- `revealed`：此刻才把 `prize` 与 reveal 材料放入内存并渲染；立即执行 5.3 核对。
- `claimed`：展示"已领取"徽章（沿用 `src/card.js:141-142`）。
- `expired`（settle 时发现跨天）：涂层复位，提示"本局已过期"，不计入新一天额度。

### 6.2 渲染门控（DOM 泄露必须根治）

- 未达 revealed 前，`.prize-name` / `.prize-result` 写死占位文案
  （"刮开涂层揭晓"/"幸运大奖"），即只保留
  `src/card.js:133-137` 的 else 分支；`card.prize` 字段在前端状态里不存在，
  从类型上让 `src/card.js:129-132` 无数据可读。
- 更进一步：pending 期间给 `.prize-layer` 加 `aria-hidden="true"` 且不渲染真实结果；
  revealed 后再移除。禁止用 `display:none` 之外的"data 属性藏奖品名"
  （`data-*`、注释节点、template 同样禁止）。
- 公平性面板（`src/main.js:149-167`）改为渲染 settle 响应的复核报告；
  pending 时入口禁用；seed 文本只在 revealed 之后出现于 DOM。
- 任何 console.* / toast / 标题/favicon 不得携带未揭晓信息。

### 6.3 localStorage 允许 / 禁止清单

允许（均不泄露未揭晓结果）：

- `scg:auth`：`{ playerToken, playerId, deviceId }`（令牌本身是凭证，需配合
  XSS 防护；见 §8）。
- `scg:prefs:<campaignId>`：用户自设的 `clientSeed`（用户自己的输入，无秘密）。
- `scg:idempotency`：进行中意图的幂等键 → `{campaignId, slot, kind, createdAt}`
  映射，用于崩溃重试；只含意图类型，不含结果。
- `scg:cache:<campaignId>:<dayKey>`：**仅 revealed/claimed** 局的展示缓存（奖品、
  receipt、reveal 材料），供离线只读与"我的奖品"展示；写入前必须过白名单过滤，
  pending 局只缓存 commitment 等 §3.7 允许字段。
- `scg:migration`：旧数据迁移状态（`importBatchId`、已完成标记、无法导入的摘要）。

禁止（任何路径不得落盘）：

- pending 局的 `serverSeed`、`roll`、`prize`、`prizeIndex`；
- 任何由本地 RNG 推出的"结果"；现有 v2 信封
  （`scratch-campaign:v2:*`，`src/main.js:170`）与 v1 key
  （`scratch-campaign-v1`，`src/lib/migration.js:277`）在迁移完成后删除；
- 服务端私钥、签名私钥（永不出服务端）。

### 6.4 跨标签页同步

- 单一事实源是 `GET /api/sync`。本地不再有"权威信封"，因此现有
  "BroadcastChannel/storage 事件 → 回 localStorage 拉信封"链路
  （`src/campaign.js:232-240`、`src/storage/sync.js:118-183`）退役。
- 保留 BroadcastChannel（`src/storage/sync.js:185-192` 可复用构造方式）只做
  **失效提示**：某页 settle/claim 成功后广播 `{kind:"changed", campaignId,
  dayKey, seq}`，他页收到后拉 sync；消息体不含奖品。
- 兜底：页面 `visibilitychange` 回前台（现有钩子 `src/campaign.js:274-276`）与
  低频轮询（建议 30s，仅在可见时）拉 sync；storage 事件不再用于业务数据
  （localStorage 已无业务信封）。
- Web Locks / CAS 不再承担正确性（无可争的本地共享状态）；仅保留单标签页内
  "同一张卡同时只有一个进行中请求"的布尔门，防止同页重复提交。
- 多页对同一 pending drawId 调 settle：允许（幂等返回同一结果）；claim 竞争由服务端
  裁决，败方按现有方式提示（`src/main.js:129-135`）。

### 6.5 网络延迟与失败的交互

- begin 在途：涂层不擦除（保持现状的"先授权后擦"，`src/card.js:64-75` 与
  `src/scratch-layer.js:312-349` 的缓冲语义可直接复用）；超时/5xx：笔画丢弃，
  卡片保持 idle，可重试（新幂等键 → 新一局会扣第二次；为避免丢笔画却扣次，客户端
  对"结果未知"的 begin 用**同一幂等键**轮询/重试，直到得到确定裁决）。
- settle 在途：涂层已刮部分保留、不淡出；结果未知时同幂等键重试；若 sync 显示该局
  已 revealed（他页/重试已完成），直接按 revealed 渲染并核对。
- claim 在途：按钮置忙；失败可"稍后领取"（与现有"稍后再说"一致
  `src/main.js:66`），revealed 中奖在宽限期内随时可补领。
- 401：清 `scg:auth` → register → 重放一次原请求（幂等键不变）。
- 409 `day-rolled`：先 sync 切换日视图，再按新一天处理用户动作。
- 所有请求带超时（建议 8s）与最多 3 次指数退避；任何失败路径**禁止**用本地计算补
  结果，只允许进入只读/锁定态（§7.1）。

---

## 7. 降级与迁移

### 7.1 服务端不可达时：只读 / 锁定，永不本地摇奖（一票否决）

- **idle 卡**：begin 失败即不可刮。涂层整体禁用（复用 `setEnabled(false)`，
  `src/scratch-layer.js:418-421`），按钮置灰，展示横幅"网络不可用，刮卡暂时锁定，
  已获得的奖品仍可查看"。不生成 seed、不模拟结果、不写任何"待开奖"本地状态。
- **pending 卡**：只显示涂层与刮卡进度（进度是用户自己的手势数据，非结果），
  settle 无法完成时不淡出、不弹窗；网络恢复后同幂等键继续 settle。禁止用
  `commitment` 做任何本地"推算"（256bit 也推不出来，设计上更不允许尝试）。
- **revealed/claimed**：从 `scg:cache` 只读展示（含"我的奖品"），claim 动作离线时
  排队待发（仅记录 drawId + 幂等键，不记录任何新结果），上线后自动重试；排队记录
  可在多标签页间通过 sync 收敛。
- 配额显示：无法 sync 时显示"剩余次数：--"，绝不依据本地缓存的 chancesUsed 放行
  begin。
- localStorage 被禁用：沿用现有内存后端降级思路（`src/storage/backend.js:15-73`）
  作为单标签页临时态，但临时态同样只缓存公开结果；无令牌时要求先 register，
  register 不可达则整个交互锁定。
- 任何降级分支出现"本地 RNG / 本地权重表决定一局结果"即违反本设计；§9 有专门断言
  扫描客户端路径中不存在摇奖调用（现有 `drawPrize/generateSeed/mulberry32`
  从前端业务路径移除，仅可作为复核算法的独立实现保留且不被 begin/settle 调用）。

### 7.2 现有本地数据导入流程

1. 首启检测：发现 `scratch-campaign:v2:daily`（`src/main.js:170`）、
   `scratch-campaign:v2:weekend` 或旧 key `scratch-campaign-v1`
   （`src/lib/migration.js:277`）存在，进入"迁移向导"，迁移完成前锁定刮卡入口。
2. 读取并规范化（可复用现有纯函数 `migrateData/sanitizeDailyState`，
   `src/lib/migration.js:293-360`、`src/lib/state-machine.js:227-259`——它们留在
   前端仅用于生成上传摘要，不再产出权威状态），向用户展示将导入的已中奖清单。
3. 用户确认后调 `POST /api/recover/legacy`（§3.8）；成功后按服务端返回的权威视图
   刷新，本地旧 key 删除（删除动作对齐现有迁移删除，`src/campaign.js:97-104`）。
4. 失败保留旧 key 与 `scg:migration` 进度，允许重试；导入进行中禁止 begin。

### 7.3 "已刮开未领取"中间态与防重复领取

- 旧数据中 `revealed` 的中奖卡（状态机定义 `src/lib/state-machine.js:196-206`）：
  服务端按 §3.8 建为带 `legacy:true` 的 revealed 记录，必须再经一次正常 claim，
  claim 的先到先得/幂等规则（§3.6、§4.2）天然防同一玩家重复领取。
- 跨设备重复：`contentHash` 全局唯一（不按 playerId 分区）。第二台设备导入同一旧
  存档 → `legacy-already-imported`(409)，只建立只读关联，不产生可领取记录。
- 存档被人为修改/多副本微变异后无法从密码学上识别（旧数据本就无任何服务端签名，
  这是历史数据的固有信任缺陷，见 §8）；缓解：仅 cutover 前快照可导入、导入总量不
  超过历史每日配置上限、白名单奖品、同设备/同 IP 速率限制、运营审计标记 legacy
  中奖，必要时人工复核。
- `scratching` 与"已 begin、刷新归一为 idle"卡（`src/lib/state-machine.js:208-224`）：
  本地 seed/prize 一律丢弃，不计 used（用户不损失也不获利：这些局从未向用户揭晓）。
  旧 v1 中带 `chanceSpent:true` 但 state 为 idle 的卡同理按未消费处理。
- 导入后当日配额：used 按服务端重建后的 revealed/claimed 局数（不超过 total）记账。

---

## 8. 边界声明：本方案防不住什么

诚实的信任边界：服务端化把"结果提前到客户端"这一具体问题关闭，但不提供超出模型的
保证。

1. **不防服务端自身作恶/失陷**。承诺-揭示能证明"seed 在 begin 时已定、结果按公示
   算法算出"，不能证明服务端没有在合法 seed 集合里挑选结果。日前哈希链
   （§5.3 可选增强）把选种子空间提前锁死，是更强约束，但仍需要信任发布过程；私钥
   泄露或内鬼可以伪造合规但虚假的局。
2. **不防被攻破的客户端**。XSS/恶意浏览器扩展/被控设备可窃取 playerToken 与已缓存
   回执、可冒用身份领取。未揭晓结果虽不在客户端，但已揭晓内容、令牌仍是攻击目标；
   仍需常规前端安全措施（CSP、依赖卫生等，不在本设计范围）。
3. **不防清存储换身份（sybil）**。无登录模型下，攻击者可无限 register 新玩家刷
   每日免费次数——防的是"同一身份超额"，不是"真人唯一性"。要防真人刷量需账号体系/
   设备证明/风控，属产品决策。
4. **dev 中间件不是生产部署**。文件存储、单进程内存锁、无速率限制、HTTP 明文都只
   适用于本机开发；真实上线需 HTTPS、加固的持久化、多实例并发控制与密钥管理
   （HSM/KMS）。中间件文件默认写到本地数据目录，本机用户可读——开发模拟不构成
   "前端不可达"的漏洞（前端进程≠服务器文件系统），但不能把它当生产信任假设。
5. **防不住传输层被完全控制的对手**（无 HTTPS 时中间人可读 revealed 响应、可替换
   manifest/公钥）；公钥钉扎与 HTTPS 必须在真实部署同时具备。
6. **旧数据导入是一次性信任例外**。cutover 前的本地记录没有服务端签名，§7.3 的
   措施只抬高成本，不能给旧中奖提供密码学真实性；这部分风险只能运营兜底。
7. **不防用户侧时间之外的服务端运维错误**：运维直接改库、错误配置权重表会留下
   manifest/签名审计痕迹，但系统不阻止合法管理员操作。
8. **揭示即公开**：结果在 settle 响应之后出现在网络响应、JS 内存、DOM、缓存是设计
   预期；截屏、录屏、肩窥、用户自行传播不在防护范围。
9. **覆盖率 60% 是纯客户端表现**（`src/coverage.js`），可被绕过直接 settle；本设计
   不把"刮满 60%"当安全条件（"直接揭开"本来就是无障碍等价路径，
   `src/card.js:99-113`）。
10. **拒绝服务/接口滥用**：中间件不提供复杂限流；玩家可消耗自己的配额、可制造大量
    幂等键，需要网关层防护。
11. **随机性最终依赖平台 CSPRNG**（`crypto.randomBytes`）；其失效属底层信任假设。

---

## 9. 验收清单（每条均可落地为 `node --test` 断言）

组织为 `test/server/*.test.js`（核心逻辑/存储，不起服务器）与少量 HTTP 适配测试
（经 Vite dev 中间件或 `node:http` 注入同一 service）。下列编号即可直接映射测试名。

**A. 保密不变量**

- A1：begin 200 响应体 JSON 中不存在 `serverSeed`/`seed`/`roll`/`prize`/
  `prizeIndex` 键，且 `commitment` 为 64 位 hex；对响应做深扫描断言。
- A2：begin 之后、settle 之前调用 sync（与 `GET /api/draws/:id`），pending 项不含
  A1 所列任何键；内存 Store 的 draw 记录字段集合单独断言"服务端内部字段从未被
  序列化出口"（用序列化白名单函数测试）。
- A3：模拟一次完整前端流程（内存 backend 注入），begin 后断言 localStorage 所有
  `scg:*` 键的序列化值中不匹配 `/seed|serverSeed|prize|prizeIndex/` 与任意奖品名
  （遍历 `DAILY_PRIZES/WEEKEND_PRIZES` 名称，对照 `src/main.js:11-22`）。
- A4：渲染门控：用纯函数把"前端卡片视图模型"渲染为 DOM 片段，pending 视图中断言
  `.prize-name.textContent === '刮开涂层揭晓'`，且元素 outerHTML 不含奖品名字符串、
  `aria-hidden='true'`；revealed 视图才含奖品名。
- A5：seed 只在 settle 成功响应中出现且恰好一次；settle 前的所有错误响应
  （no-chances/day-rolled/unknown-draw/500）与服务端日志捕获器中均不含 seed 或
  prize（注入 logger spy 断言）。
- A6：expired 局（跨天未 settle）sync 只返回 `{status:'expired', commitment}`；
  Store 中对应 serverSeed 字段已删除（内存实现断言 `=== undefined`，文件实现断言
  重写后的 JSON 不含该 hex）。

**B. 幂等 / 重放 / 并发**

- B1：同一 Idempotency-Key 连续调用 begin 5 次：只扣 1 次（`chancesUsed===1`）、
  drawId 相同、响应字节级一致。
- B2：同键不同体调用返回 `idempotency-conflict` 且状态不变。
- B3：耗尽当日配额后再 begin 返回 `no-chances`，不建局、计数不增加。
- B4：构造同一 dayKey 的 N（=total+5）个并发 begin（内存共享 store + Promise 锁），
  成功数恰为 total，无超发。
- B5：settle 同键重试 3 次返回同一 prize/roll/receipt.sig；不同键对已 revealed 局
  settle 返回首次缓存结果而非错误丢结果。
- B6：两个不同幂等键并发 claim 同一 revealed 局：恰一方 `claimed`，另一方
  `already-claimed`；最终状态 claimed，receipt seq 只递增一次。
- B7：用 A 的 token 访问 B 的 drawId（begin/sync/settle/claim）全部
  `forbidden-owner`，且不泄露该局任何字段。
- B8：幂等记录超过 TTL（注入时钟）后旧键重放按新请求处理或返回过期错误，但不得在
  TTL 内重放成功伪造第二次领取。

**C. 时钟 / 跨天**

- C1：服务端时钟推进过 00:00（UTC+8）后 sync 返回新 dayKey、计数归零；前一日
  revealed 中奖在宽限期内仍 claim 成功，过期后 claim 返回 `claim-window-closed`。
- C2：服务端时钟回拨（今天 → 昨天 → 今天）：计数不复活、`maxObservedDayKey` 单调，
  回拨窗口内 begin 得到 `day-rolled`，总发奖次数不增加。
- C3：客户端传入任意伪造 dayKey/Date 均不影响服务端记账（服务端从不读取客户端日期
  做裁决；断言 service 接口根本不接受 dayKey 参数）。

**D. 公平性协议**

- D1：确定性：固定 (serverSeed, clientSeed, nonce, manifest) 多次计算
  `computeOutcome` 结果完全相同；serverSeed 单 bit 翻转以压倒性概率改变 roll
  （抽样断言）。
- D2：分布性：固定 manifest 权重，对 10^5 个 CSPRNG seed 开奖，各类奖品频率落在
  权重 ±3σ 区间。
- D3：承诺：`sha256(serverSeed)` 与 begin 的 commitment 严格相等；篡改 settle 返回
  的任意 hex 字符，前端复核函数（可移植为同算法纯函数单测）三项核对至少一项失败。
- D4：签名：用公钥验证 receipt 成功；篡改 payload 任一字段后验签失败；错误 kid 返回
  `unknown-key`。
- D5：256bit 抗性量级断言（文档性测试）：随机抽取 2^20 个 32bit 风格短 seed 演示旧
  方案选种期望 < 50 次命中 5% 档（复现 §2.1-A），并断言新方案 commitment 空间为
  2^256（长度/格式断言），表达安全量级差异。

**E. 迁移 / 降级 / 边界**

- E1：recover/legacy 正常导入 revealed 中奖后：生成 legacy revealed 记录，claim
  成功；相同 contentHash 第二次导入（同 playerId 与新 playerId 各一次）均得到
  `legacy-already-imported`，全局可领取记录只有一条。
- E2：导入含非法奖品名/超额记录被拒绝或裁剪，且不产生任何可 claim 中奖。
- E3：旧 `scratching`/已 begin 未揭晓卡导入后：无 pending 局、配额不计该次、
  上传摘要外的本地 seed/prize 被删除流程标记清理。
- E4：service 全部写接口在"网络不可达"（HTTP 层直接失败）时，前端视图模型的
  reducer 断言：idle 保持 idle、不产生 prize 字段、缓存只读、chancesLeft 为
  `null/--`；代码路径扫描测试断言 `src/**` 业务模块不 import
  `server/core/draw.js`，且不调用 `generateSeed/drawPrize/mulberry32`
  （复核工具函数允许存在但通过依赖图断言不被状态迁移调用）。

**F. 工程边界**

- F1：`test/` 现有 `node --test` 全部通过；`npm run build` 通过；客户端 bundle
  （`vite build` 产物）中 grep 不到 `server/` 模块路径与 `node:crypto` 字样。
- F2：`package.json` 依赖集合不变（无新增运行时依赖；断言 dependencies/devDependencies
  快照）。
- F3：`src/**.js` 静态扫描：无对 `../../server`、`/server/` 的 import；
  `server/**` 不 import `src/**`（双向边界各一条断言）。
- F4：HTTP 适配测试：中间件对未认证请求 401、JSON 错误体格式统一、非 API 路径仍由
  Vite 静态处理（`GET /` 返回 index.html）。

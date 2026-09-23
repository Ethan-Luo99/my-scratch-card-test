# 幸运刮刮卡 · 服务端权威化安全设计（评审稿）

- 文档性质：安全评审 + 方案设计，**只出设计，不含实现**。
- 安全目标（原文复述）：**"结果永远不提前抵达客户端。"** 未揭晓卡片的 seed / 奖品
  不允许出现在前端可达的任何位置（localStorage、DOM、网络响应、JS 内存）；
  开奖必须由前端无法读取内部状态的"服务端"完成。
- 范围约束：
  - 不引入第三方运行时依赖；模拟服务端用 Vite dev server 中间件实现（真实 HTTP），
    前端禁止 `import` 服务端模块；服务端逻辑可被 `node --test` 直接单测。
  - 任何路径（降级、离线、多标签页、数据迁移）都**不得本地摇奖**，一票否决。
- 现状基线：`npm test` 41/41 通过；`npm run build` 通过（审计时实测）。
  本设计落地前不改 `src/`、`test/`、`package.json` 及任何现有文件。

---

## 一、现状审计

> 证据均为仓库内当前代码的 `文件:行号`，可逐条复核。行号基于本次评审的工作区版本。

### 1.1 prize / seed / seedHash 的完整数据流

**生成（浏览器本地，begin 瞬间）**

- seed 在活动引擎的 `beginScratch` 入口处、**进入提交流程之前**就由前端生成：
  `src/campaign.js:327` `const seed = generateSeedFn() >>> 0`。
- 随机源是浏览器 `crypto.getRandomValues`（不可用时退化为 `performance.now()`
  + 计数器的弱兜底）：`src/lib/randomness.js:57-72`，仅 32 bit。
- 奖品在纯状态机迁移里由 seed 确定性算出并**与 seed 同时落定**：
  `src/lib/state-machine.js:172-179`
  - `nextCard.seed = seed >>> 0`（:176）
  - `nextCard.prize = drawPrize(prizes, nextCard.seed)`（:177）
  - `nextCard.seedHash = fnv1aHex(String(nextCard.seed))`（:178）
  - 同一步扣减当日次数 `next.chancesUsed += 1`（:174）。
- 摇奖算法：`mulberry32(seed)` 取第一个随机数 × 权重和做加权选择，
  `src/lib/randomness.js:12-20`（PRNG）、`src/lib/randomness.js:34-54`（开奖）。

**落盘（localStorage 明文信封）**

- 存储 key 按活动命名空间：`scratch-campaign:v2:<campaignId>`，
  `src/main.js:170`。
- 信封结构 `{ version, rev, state:{ date,lastDate,timeAnomaly,chancesUsed,
  cards:{ [cardId]: { state, chanceSpent, prize:{name,win}, seed, seedHash } } } }`，
  注释明示 seed/prize 在信封内：`src/lib/migration.js:4-16`；
  初始卡字段含 `seed/seedHash`：`src/lib/state-machine.js:118-120`。
- 写盘是 `JSON.stringify(envelope)` 后整包 `setItem` 明文：
  `src/campaign.js:129-163`（`casWrite`），底层直接写 `window.localStorage`：
  `src/storage/backend.js:59-73`。
- 旧版 v1 单 key `scratch-campaign-v1` 会被无损迁移到 v2（奖品明文同样带入）：
  `src/lib/migration.js:71-108`；读取回退逻辑在 `src/campaign.js:72-104`。

**内存持有**

- 每个活动实例在闭包里常驻整份信封（含所有卡 seed/prize）：
  `src/campaign.js:53` `let envelope = null`，读取后整包驻留；
  `getCard` 直接返回卡对象（含 `prize/seed`）：`src/campaign.js:318`。
- 奖品配置本身就是前端常量（攻击者本就知道全部奖池与权重）：
  `src/main.js:11-22`。

**DOM 渲染（未刮开也已进 DOM）**

- 卡面模板里奖品层 `<span class="prize-name">` 与涂层 canvas 是兄弟节点：
  `src/card.js:22-32`。
- `update()` 只要 `card.prize` 存在就把中奖文案/奖品名写进 DOM：
  `src/card.js:129-137`（`prizeName.textContent = card.prize.name` 在 :132）。
  这发生在卡片处于 idle / scratching（涂层还在）时——即**未揭晓状态下奖品文本
  已在 DOM**。
- 奖品层是"底层"、canvas 涂层是"上层"，仅靠视觉遮挡：
  `src/style.css:237-247`（`.prize-layer` absolute）与
  `src/style.css:266-275`（`.scratch-canvas` absolute 覆盖）。
  DOM 文本、可访问树、`element.textContent` / DevTools / 读屏器均可直接取得，
  不属于安全边界。
- 结果弹窗直接读 `card.prize` 渲染：`src/main.js:96-114`；
  公平性面板把 **seed 明文**直接渲染出来：`src/main.js:155-165`（:157）。

**跨标签页流动（他页拉取整包明文）**

- 写后只广播 `{ rev }` 提示：`src/campaign.js:213-217`、
  `src/storage/sync.js:163-172`。
- 接收方收到提示后**回 localStorage 拉取整份信封**（含未刮开卡的 seed/prize）：
  `src/campaign.js:232-240`（`pullRemote -> readLatest`），
  `readLatest` 整包读取：`src/campaign.js:65-122`。
- 无 BroadcastChannel 时退化为 storage 事件，同样回存储拉整包：
  `src/storage/sync.js:137-143`。
- `visibilitychange` 回前台也会全量拉取：`src/campaign.js:274-276`。
  结论：任一标签页 begin 后，**同源所有标签页的 localStorage 与 JS 内存**
  立刻持有该未揭晓卡的 seed 与奖品明文。

**时序上的一个细节（注释与实现不符）**

- `src/campaign.js:323-325` 注释称"seed 在进入此方法的锁内迁移时才生成，
  此前不存在于任何可读位置"，但实现是 `src/campaign.js:327` 在
  `commitTransition`（:184，锁在 :226-229 才获取）**之前**生成。
  这不影响当前安全结论（反正都在客户端），但属于文档与代码不一致，
  服务端化后该方法将被远端 begin 取代。

### 1.2 泄露面评级

| # | 泄露面 | 证据 | 评级 | 说明 |
|---|---|---|---|---|
| L1 | localStorage 明文存 seed+prize+seedHash | `src/lib/migration.js:4-16`、`src/campaign.js:129-163`、`src/storage/backend.js:59-73` | **严重（Critical）** | 任何能执行同源 JS 的代码（XSS、恶意扩展、DevTools）都能在刮开前读到结果；`seed` 还可被直接改写/挑种。 |
| L2 | 未刮开时奖品文本已进 DOM（仅 CSS 遮挡） | `src/card.js:129-137`、模板 `src/card.js:22-32`、层叠 `src/style.css:237-275` | **严重（Critical）** | 视觉隐藏不是安全控制：DevTools、读屏器、`textContent`、嗅探扩展在 begin 后即可见。 |
| L3 | 跨标签页拉取整包"信封"，连带未揭晓卡 | `src/campaign.js:232-240`、`src/storage/sync.js:137-143` | **高（High）** | 一张卡在 A 页 begin，B 页 localStorage/内存即获 seed+prize；扩大了 L1 的暴露面。 |
| L4 | seed 仅 32 bit，可离线穷举/挑种 | `src/lib/randomness.js:57-61`（Uint32Array(1)）、`:12-54`（mulberry32+权重） | **中（Medium，当前被 L1 掩盖，服务端化后必须消除）** | 见 1.3 量级实测。 |
| L5 | seedHash 用 FNV-1a 32bit，非密码学承诺 | `src/lib/randomness.js:23-31`、调用处 `src/lib/state-machine.js:178` | **中（Medium）** | FNV 非抗原像、输出仅 32 bit；且当前 hash 与 seed 同包返回（`src/campaign.js:337-340` 返回整张 card），承诺没有"先于结果公布"的时间属性。 |
| L6 | 客户端全权：奖池/权重/扣次/状态全可被篡改 | 配置 `src/main.js:11-43`；扣次 `src/lib/state-machine.js:172-181`；CAS 仅防客户端自己的并发 `src/campaign.js:129-163` | **严重（Critical，业务侧）** | 改本地 `chancesUsed`/`prize.win` 即无限刷奖；localStorage CAS 不构成对服务端的权威。 |
| L7 | 公平性验证在客户端自证 | `src/campaign.js:371-389`、`src/main.js:149-167` | **中（Medium）** | seed、hash、算法、待核对奖品都在同一可信域（客户端），无法向用户证明"平台没改结果"。 |

### 1.3 seed 32bit + FNV-1a 32bit 的离线可穷举性（实测量级）

在**本机单线程 Node、未做任何优化**下，用仓库现有 `mulberry32 + drawPrizeIndex`
实测（审计时运行，非估算）：

- 纯摇奖枚举速度 ≈ **61.9 M seeds/s**，遍历完整 32 位空间 `2^32 ≈ 4.29e9`
  约 **69 秒**（单核；多核/原生 SIMD/GPU 可再降一个数量级以上）。
- 连 FNV-1a 一起算 ≈ **10 M/s**，全空间约 **428 秒**（约 7 分钟）。
- 攻击者目标通常不是遍历，而是"挑中头奖的种子"：按现有每日奖池
  `weight:5/10/15/70`（`src/main.js:11-16`），头奖概率 5%，
  本次实测平均仅需约 **20 次**尝试即可枚举到一个开出头奖的 seed。

结论：**32 位 seed 在离线攻击面前等于没有秘密**。一旦未来把 seed 藏起、
只给 hash（L5 路径），攻击者可：

1. 枚举 2^32 seed，按已知权重表（奖池本来就是前端公开常量，
   `src/main.js:11-22`）本地 `drawPrize`，筛选开出头奖的种子；
2. 用 FNV-1a 32bit 对候选求 hash，与承诺比对，碰撞/命中成本极低；
3. 甚至在 begin 阶段"挑种"。

因此服务端方案必须：seed 至少 **128 bit** 且永不离开服务端直至揭晓；
承诺使用**密码学哈希（SHA-256）**，且承诺必须在结果可知之前就固定并可留存。

### 1.4 现有机制：哪些收归服务端，哪些留在前端

| 现有机制 | 现状位置 | 服务端化后的归属 |
|---|---|---|
| 生成 seed / 摇奖 / 锁定奖品 | `src/lib/randomness.js`、`src/lib/state-machine.js:172-181` | **全部收归服务端**。前端不得存在任何可由 seed 推出奖品的算法副本（奖池"名称/展示文案"可在揭晓后由服务端下发；权重表不暴露给未揭晓流程也无妨）。 |
| seedHash 承诺 | `src/lib/randomness.js:23-31`、`src/lib/state-machine.js:178` | **收归服务端**：服务端在 begin 时只下发 SHA-256 承诺与签名；seed 在 reveal 时才随结果下发。 |
| 可验证公平性（重算/核对） | `src/campaign.js:371-389`、`src/main.js:149-167` | **拆分**：结果与 seed、签名由服务端给；"核对 hash/签名/重算"这个**只读校验动作**可留在前端，但不能在揭晓前推断结果。 |
| 每日次数记账 | `src/lib/state-machine.js:166-175`、`src/campaign.js:296-298` | **收归服务端原子记账**；前端只显示服务端返回的剩余次数。 |
| 锁 + CAS（防多标签页并发） | `src/campaign.js:129-163,184-230`、`src/storage/sync.js:209-251` | **服务端幂等 + 原子状态机**取代其安全职责；前端可保留 UI 级去抖/禁用，但不再作为正确性来源。 |
| 跨天 / 时间回拨 | `src/lib/time.js:122-170`、`src/campaign.js:279-290` | **以服务端时钟为准**；前端时钟只用于展示，不参与授权/重置。 |
| localStorage 信封（真相源） | `src/storage/backend.js`、`src/lib/migration.js` | 真相源移到服务端；localStorage 降级为**只读缓存/缓存已揭晓内容**，严禁存未揭晓 seed/prize。 |
| 跨标签页同步 | `src/storage/sync.js`、`src/campaign.js:232-276` | 改为**以服务端状态为准**的轮询/可见性重拉/同标签页事件；不再从 localStorage 拉未揭晓信封。 |
| 刮层渲染/覆盖率 60% | `src/scratch-layer.js`、`src/coverage.js`、`src/card.js:76-97` | **留前端**（纯表现层）。覆盖率只决定"何时调用 reveal"，不决定结果。 |
| 状态机 UI 呈现 | `src/card.js:116-153` | 留前端，但字段改为服务端凭证驱动；未揭晓时不渲染奖品文本。 |

---

## 二、方案设计（server-authoritative）

### 0. 总体形态与代码布局（仅设计，不实现）

- 新增**独立服务端目录**（不在 `src/` 内），例如：
  - `server/app.js`：导出 `createServerApp({ clock, store, signer })`
    纯函数式工厂，返回一个 Node `http` 请求处理器 `(req,res)=>...`，
    **只依赖 Node 内置模块**（`node:crypto`、`node:http` 等），无第三方依赖。
  - `server/store.js`：内存（+可选 JSONL 快照）存储、原子读改写、幂等键去重。
  - `server/rng.js`：`crypto.randomBytes(16)` 生成 128bit seed、
    SHA-256 承诺、Ed25519 签名（均内置 `node:crypto`）。
  - `server/weights.js`：服务端奖池/权重（权威），按 `campaignId + configVersion`
    版本化，避免中途改权重使历史承诺失效。
  - `server/index.js`（dev 专用，可选）：`createServer` 监听端口。
  - `vite.config.js`（新增）：`server.middlewareMode`/`configureServer` 中
    `app.use('/api', createServerApp(...))`，**仅在 dev 挂载**。
    `vite.config.js` 由 Node 加载，不属于前端 bundle，前端**不 import** `server/**`。
  - 生产构建 `vite build` 不包含服务端代码；真实部署时 `server/index.js`
    可独立 `node server/index.js` 运行（本设计只要求 dev 中间件 + 可单测）。
- 前端只通过 `fetch('/api/...')` 与服务端交互；新增前端 API 客户端模块
  （`src/**` 的改造属于后续实现，本文档只规定契约与门控）。
- 单测：`node --test server/*.test.js` 直接 `import { createServerApp }`，
  用可注入的 `clock`/`store`/`signer` 和内存 store 发真实/模拟请求断言。
- **红线**：前端 bundle 中不出现权重摇奖算法与未揭晓 seed；评审用
  "begin 响应体 + localStorage + 渲染前 DOM/内存快照"三方检查验收。

> 注：当前仓库无 `vite.config.js`，`npm run dev` 用零配置。新增配置文件属于
> 实现阶段动作；本文档只设计其内容，不在本次改动中创建。

### 1. API 契约

基础约定：

- Base path：`/api`；全部 `POST`（除只读 `GET` 同步/健康检查）；
  请求/响应 `application/json`；时间一律服务端 ISO-8601（UTC）+ 日期按
  服务端配置时区（建议固定 `Asia/Shanghai`，与现状一致：`src/lib/time.js:123-128`）。
- 身份：`POST /api/session` 由服务端 `Set-Cookie` 下发
  `sid=<128bit 随机>; HttpOnly; SameSite=Lax; Path=/`（dev http 下 Secure 省略）。
  所有写接口以该会话为权威主体。**身份状态只存服务端 + HttpOnly cookie**，
  JS 不可读。无会话访问受保护接口返回 `401 {error:'no-session'}`。
- 幂等：每个**会改变状态的客户端动作**携带 `Idempotency-Key`（建议
  `crypto.randomUUID()`，仅作为去重令牌，无秘密含义）。服务端按
  `(sid, 路由语义, key)` 缓存首次响应，重试在 TTL 内原样返回。
- 通用错误体：`{ "error": "<code>", "message"?: string }`；
  可能码：`no-session`、`unknown-campaign`、`unknown-card`、`no-chances`、
  `invalid-state`、`already-claimed`、`conflict`、`rate-limited`、`bad-request`。
  业务冲突用 **HTTP 200 + `ok:false,reason`**（与现状 `{ok:false,reason}`
  风格一致：`src/campaign.js:190-198`）或 4xx，二者固定其一；本设计统一
  用 **200 + `ok:false`** 表达"请求合法但业务不允许"，4xx 仅表达协议/鉴权错误。
- 所有卡片对象对前端的形态（**未揭晓时绝不含 seed/prize**）：
  ```
  {
    cardId, campaignId,
    status: 'idle'|'pending'|'revealed'|'claimed',
    rev: number,                 // 服务端资源版本，乐观并发用
    commitment?: string,         // begin 后、reveal 前：仅 SHA-256 承诺
    prize?: { name, win },       // 仅 status=revealed/claimed 才出现
    receipt?: { seed, algorithm, weightsVersion, signature, serverTime } // 仅揭晓后
  }
  ```

#### 1.1 `POST /api/session`（建立/恢复会话）
- 请求：`{}`（可选 `{ legacyImport?: token }`，见第 5 节）。
- 响应 200：`Set-Cookie: sid=...`，体
  `{ sessionRef, serverTime, day:'YYYY-MM-DD', campaigns:[{campaignId,title,subtitle,dailyChances,cardIds:[...]}] }`。
- 只返回**展示所需元数据**（卡位数、活动名、每日总次数），不含任何卡结果。

#### 1.2 `POST /api/campaigns/:cid/scratch/begin`（开始刮 = 占用一次机会）
- 请求头：`Idempotency-Key`。体：`{ cardId }`。
- 服务端动作（原子）：校验会话/活动/卡 → 判定当日剩余次数（服务端时钟）
  → 生成 128bit `seed`（`crypto.randomBytes(16)`）→ 按权威权重摇奖并**只存服务端**
  → 计算 `commitment = SHA256(seed || campaignId || cardId || weightsVersion)`
  → 写 `pending` 记录（seed/prize 仅服务端可见）→ 扣 1 次。
- **响应 200（成功，只能含"承诺"）**：
  ```
  { ok:true,
    card:{ cardId, campaignId, status:'pending', rev,
           commitment, expiresAt },
    chancesLeft, day, serverTime,
    commitSig }   // 服务端对 {campaignId,cardId,commitment,expiresAt,day} 的 Ed25519 签名
  ```
- **为什么 begin 响应只能含承诺（hash/会话引用），不能含 seed/奖品**：
  begin 发生在用户刮开涂层**之前**（现状 begin 挂在首次 `pointerdown`：
  `src/card.js:64-75`）。此响应会进入 JS 内存、可被 DevTools/扩展/日志/错误上报
  捕获。只要响应含 seed，客户端就可能：直接读结果；或本地复算（权重表本就
  可公开）；或离线挑种（见 1.3，32bit 仅 ~69s 全枚举）。含奖品明文同理。
  而承诺 `SHA256(seed||上下文)`：
  1) 不泄露 seed（抗原像）；2) 不泄露奖品（seed 128bit 不可枚举，且承诺不含
  奖品字段）；3) 把"服务端在刮开前就已固定结果"这件事**不可抵赖地绑定**下来，
  供揭晓后核对（见公平性重构）。`commitSig` 防止承诺被中间层替换。
  因此 begin 响应里**唯一允许与未来结果相关的字段**就是 `commitment(+签名+过期时间)`。
- 幂等/并发：同一 `Idempotency-Key` 重放返回同一 `commitment/rev`，不重复扣次；
  对同一 `cardId` 在已有 `pending` 时再次 begin（不带原 key，例如多标签页）
  返回 `{ok:false, reason:'already-pending', card:{...同一承诺...}}`，**不新增扣费**；
  当日次数不足：`{ok:false, reason:'no-chances', chancesLeft:0}`。

#### 1.3 `POST /api/campaigns/:cid/scratch/reveal`（结算/揭晓）
- 请求：`{ cardId, expectedRev? }`，头带 `Idempotency-Key`（建议每卡每次揭晓一个
  稳定 key，便于重试去重）。
- 前置：卡须为该会话 `pending`（已 begin 扣费）。`expectedRev` 用于乐观并发，
  不匹配返回 `{ok:false,reason:'conflict', card:<最新公开视图>}`。
- 服务端动作：原子把 `pending -> revealed`，记录 `revealedAt`，
  **此刻才**生成可下发的 `receipt`。
- 响应 200（这是结果**第一次**可以抵达客户端的时刻）：
  ```
  { ok:true,
    card:{ cardId, campaignId, status:'revealed', rev,
           prize:{ name, win },
           receipt:{ seedHex, algorithm:'mulberry32-sha256-commit-v1',
                     weightsVersion, commitment,
                     serverTime, signature } },
    chancesLeft, serverTime }
  ```
  - `receipt.signature` = Ed25519 服务端私钥对
    `{campaignId,cardId,seedHex,commitment,prize{name,win},weightsVersion,serverTime}`
    的签名；公钥经 `GET /api/verification-key` 获取（见 1.7）。
  - 服务端在响应前自检 `commitment === SHA256(seedHex||cid||cardId||weightsVersion)`
    且 `prize === draw(weightsVersion, seed)`，不一致则拒绝并告警（防服务端自身 bug）。
- 重复 reveal（网络重试 / 双页）：幂等返回**同一结果与同一 receipt**，不改变状态。
  对 `claimed` 状态调 reveal：返回当前 claimed 视图（含 receipt，若已下发过）。

#### 1.4 `POST /api/campaigns/:cid/prizes/claim`（领取）
- 请求：`{ cardId }` + `Idempotency-Key`。
- 前置：`revealed`（中奖与未中奖都可推进，与现状一致：
  `src/main.js:122-140` 注释明确"知道了"也推进 claim 以消除悬挂态）。
- 服务端动作：原子 `revealed -> claimed`，写 `claimedAt`，幂等键落库。
- 响应 200：`{ ok:true, card:{...status:'claimed', prize, receipt, claimRef}, serverTime }`。
- 双标签页同时领：仅一方 200 首成功；另一方
  `{ok:false, reason:'already-claimed', card:{...claimed...}}`（对应现状
  先到先得：`src/campaign.js:352-365`，但裁决权在服务端）。
- 幂等重试：同 key 返回首次的 `claimRef`，不重复发奖。

#### 1.5 `GET /api/state?campaign=:cid`（同步；可省略 campaign 拉全部）
- 返回该会话**当前可公开视图**：
  ```
  { serverTime, day,
    campaigns:[{ campaignId, chancesLeft, dailyChances,
      cards:[ {cardId,status,rev,commitment?,prize?,receipt?,expiresAt?} ] }] }
  ```
- 字段门控与 1.2/1.3 完全一致：`pending` 卡**只有 commitment，无 seed/prize**；
  `revealed/claimed` 才有 prize/receipt。该接口是多标签页/回前台/轮询的唯一真相源。

#### 1.6 `POST /api/recover`（刷新/崩溃恢复）
- 请求：`{}`（凭 cookie）。等价于"重建页面所需全部公开状态"，返回同 1.5
  的全量视图 + 各活动元数据（避免前端依赖 localStorage 还原）。
- `pending` 卡恢复后前端如何处理见前端改造（涂层复原、可再次刮开，
  机会不退还、结果不变——服务端持有同一 seed/prize）。

#### 1.7 `GET /api/verification-key` 与 `GET /api/healthz`
- verification-key：`{ alg:'Ed25519', publicKeyHex, keyId, issuedAt }`。
  前端可缓存公钥；揭晓后用它验签（也可仅展示，供高级用户外部核验）。
- healthz：`{ ok:true, serverTime }`；前端用于降级判定（不代表可摇奖，
  仅用于决定只读/锁定 UI）。

#### 1.8 `POST /api/migrate/import`（仅迁移旧本地数据，见第 5 节）
- 请求：`{ payload: <旧信封 JSON>, payloadHash }` + `Idempotency-Key`。
- 服务端对 claimed/revealed 的中奖记录做去重登记；对未揭晓数据按第 5 节策略
  处理；响应 `{ ok:true, imported:{ claimed:[cardRef...], revealed:[...] },
  discarded:{ spentUnrevealed:[...] } }`。

### 2. 服务端设计

#### 2.1 进程模型与依赖红线

- 零第三方运行时依赖：密码学全部用内置 `node:crypto`
  （`randomBytes`、`createHash('sha256')`、`generateKeyPairSync('ed25519')`、
  `sign/verify(null, ...)`）；HTTP 用 `node:http` 或 Vite 中间件的
  `(req,res,next)` 适配薄层。
- dev：`vite.config.js` 的 `configureServer(server){ server.middlewares.use('/api', handler) }`
  挂载；该文件只被 Node/Vite 配置加载，前端不引用。
  `fetch('/api/...')` 与静态资源同源，真实经过 HTTP 栈（可设置 cookie、状态码）。
- 可测：业务在 `createServerApp` 内，与"监听端口/Vite"解耦；测试构造
  `{ clock, store, signer, weights }` 注入，直接调用 handler（或用
  `node:http` 起临时端口发真实请求），`node --test` 可跑。

#### 2.2 服务端数据模型（内存 + 可选 JSONL；单实例模拟）

- `sessions: Map<sid, { createdAt, day, lastSeenAt }>`
- `days: Map<sid#campaignId#day, { chancesUsed, createdAt, updatedAt }>`
- `cards: Map<sid#campaignId#cardId, CardRecord>`，其中
  `CardRecord`（**含秘密字段，永不出现在未揭晓响应**）：
  ```
  { sid, campaignId, cardId,
    status: 'pending'|'revealed'|'claimed',
    rev, day, weightsVersion,
    seedHex,            // 128bit，仅服务端
    prize:{name,win},   // 摇奖结果，仅服务端直到 revealed
    commitment,
    beginAt, expiresAt, revealedAt?, claimedAt?, claimRef? }
  ```
- `idempotency: Map<scope#key, { status:'done', response, at }>`，TTL（如 24h）。
- `claimsLedger: Set<dedupKey>` 与迁移登记（见 2.5 / 第 5 节）。
- 持久化（仅为 dev 重启不丢，非信任必需）：所有变更**追加写 JSONL**
  （`fs.appendFile`，一行一事件），启动时顺序回放重建内存；
  文件加入 `.gitignore`（实现阶段）。崩溃恢复靠事件日志的原子追加。
  生产形态应替换为带事务的数据库，但接口不变。

#### 2.3 原子性、并发与状态机

- 单 Node 进程内：每个写处理用"读—改—写"临界区串行化
  （一个按 `sid` 分片的 async mutex / 队列；测试可直接并发请求验证）。
  这是把现状 Web Locks + localStorage CAS（`src/campaign.js:129-163`、
  `src/storage/sync.js:209-251`）的安全职责上移到权威端：**多标签页并发
  在服务端天然被同一会话串行裁决**。
- 资源版本 `rev`：每次卡状态迁移 +1，并随响应返回；客户端可带
  `expectedRev` 做乐观检测（主要用于把过期 UI 拉回，不作为安全边界）。
- 卡状态机（服务端唯一权威，替代
  `src/lib/state-machine.js:160-206` 的客户端迁移）：
  ```
  (无记录) --begin(扣费,生成seed,摇奖,存秘密)--> pending
  pending   --reveal(下发prize+seed+签名)-----> revealed
  revealed  --claim----------------------------> claimed（终态）
  ```
  - begin 对"无记录"或"幂等重放原 key"才生效；已有 pending 且 key 不同
    → 复用该 pending（同一承诺），不重复扣费；对 revealed/claimed 调 begin
    → `invalid-state`，不扣费、不重摇。
  - reveal/claim 只接受严格前驱状态，否则 `invalid-state`/`already-claimed`。

#### 2.4 次数记账（原子 + 幂等）

- 扣费只发生在**首次** begin 成功的同一事务内（与现状
  "chanceSpent 幂等护栏"思想一致，`src/lib/state-machine.js:166-179`，
  但记账在服务端）：
  1) `days` 记录的 `chancesUsed < dailyChances` 判定；
  2) 同事务内 `chancesUsed+1` 并建 pending 卡 + 写幂等结果。
  任一步失败整体回滚（内存即丢弃副本，JSONL 不写半事件）。
- 幂等键命中：直接返回缓存响应，**绝不二次扣费**。
- 多标签页并发 begin：串行后第二者看到"已有 pending/已达上限"，
  最多扣一次。
- 上限与卡位数解耦（现状 daily=3 卡 3 张、weekend=5 卡 4 张：
  `src/main.js:24-43`）：次数是"当日 begin 成功次数"，卡是结果槽位；
  服务端按 `(sid,campaign,day)` 记账，卡按 cardId 存放。若产品语义仍是
  "每张卡每天至多一次"，则以卡存在非 idle 记录为准；本设计以**每日总次数**
  为权威约束，与现状 `chancesUsed/dailyChances`（`src/campaign.js:296-298`）对齐。

#### 2.5 防重放矩阵

| 场景 | 客户端动作 | 服务端裁决 |
|---|---|---|
| begin 请求超时后重试 | 同 `Idempotency-Key` 重发 | 返回首次 commitment，扣次不变 |
| 双击/两页同时 begin 同一张卡 | 不同 key 并发 | 串行；首请求建 pending 扣费，次请求得 `already-pending` 复用承诺，不另扣 |
| reveal 网络重试 | 同/不同 key 再发 | 幂等返回同一 prize+receipt；状态仍 revealed |
| 两页同时 claim | 并发 | 一方首成功转 claimed；另一方 `already-claimed`（先到先得，服务端裁决） |
| claim 成功但响应丢失后刷新 | GET /state 或带 key 重发 | 看到 claimed + 同一 claimRef；不重复发奖；`claimsLedger` 去重 |
| 重放旧 cookie 到次日 | 任意 | 以服务端日期开新账本，旧 claimed 不可再领 |
| 改本地 rev/chancesUsed 后请求 | expectedRev 伪造 | 服务端只信自有状态；伪造仅导致 `conflict` 与视图纠正，不增次数/不改结果 |

幂等键存储与 `claimRef` 同时落 JSONL；`claimsLedger` 的去重键建议
`sid#campaignId#cardId#weightsVersion#seedHex`（迁移卡用服务端补登的稳定 ref）。

#### 2.6 时钟：跨天与回拨一律以服务端为准

- 服务端用注入的 `clock()`（生产 `Date.now`，测试可拨），按固定时区算
  `day=YYYY-MM-DD`。`days` 键含 day，跨天自然产生新账本，无需信任客户端日期。
- 取代现状的客户端回拨逻辑（`src/lib/time.js:150-170`、
  `src/campaign.js:279-290`）：客户端改本地时间**完全无效**——
  begin/reveal/claim 的授权与剩余次数只看服务端 day。
- 服务端自身时钟回拨的处理（模拟实现的诚实边界）：
  - 不做"绝对真时"假设；以**已持久化事件**为单调基线：
    新事件时间戳 `< 已有最大时间戳` 时，仅记录 `clockAnomaly`，
    **不回退 day 账本、不恢复已用次数**（沿用更晚的已记账日，
    等价于现状 `resolveDay` 的"回拨沿用"规则，但由服务端持有基线）。
  - pending 卡的归属日在 begin 时固化（`CardRecord.day`）；跨天后该卡
    仍可完成 reveal/claim，不占用新一天次数。
- 前端收到的 `serverTime/day` 仅用于展示与倒计时，不参与任何授权判定。

#### 2.7 seed 的生成、存储与销毁时机

- **生成**：仅在 begin 事务内 `crypto.randomBytes(16)`（128bit），
  用注入式 RNG 以便单测；权重摇奖在服务端用服务端权威权重表执行。
  彻底取代前端 32bit `generateSeed`（`src/lib/randomness.js:57-72`）。
- **存储**：seed/prize 只存在 `CardRecord`（服务端内存 + JSONL）。
  - 内存为进程私有，前端不可达；JSONL 文件不通过任何静态路径暴露
    （放在 Vite `public`/根静态目录之外，且不被任何路由读取）。
  - 可选 at-rest 保护：dev 模拟可接受明文文件（单机、gitignore）；
    若要更强，可在启动时生成进程密钥对 JSONL 中 seed 字段加密
    （内置 crypto，非第三方依赖）——本设计列为可选项，不作为验收门槛。
- **销毁**：
  - reveal 后 seed 已作为 receipt 下发（公开给该用户，不再是"未揭晓秘密"），
    服务端仍保留以支持 `/state` 重取与验签；
  - `claimed` 终态后，可在保留期（如对账窗口 N 天）后**从热存储清除 seed/prize**，
    仅保留 `claimRef`/签名/去重索引以防重复领取；
  - pending 超过 `expiresAt`（如 15 分钟，仅释放"涂层进行中"的展示态）
    时：**机会不退还、结果不重摇**，记录转为 `pending-expired`（内部态），
    用户恢复/再刮仍命中同一 seed/prize（与现状 scratching 刷新归一
    一致：`src/lib/state-machine.js:212-224`）。仅当产品明确允许"放弃重抽"
    才可作废——本设计默认**不作废、不重摇、不退次**。
- 任何错误响应、日志（实现时注意）、健康检查、统计字段均不得带出 seed/prize；
  日志只记 cardId/status/rev，不记秘密（列为验收检查项）。

### 3. 公平性重构：客户端不能复算"未开奖结果"后，如何保持可验证

现状的"可验证"是客户端拿 seed 本地重算（`src/campaign.js:371-389`），
问题是 seed 在未揭晓前就在客户端，且没有"先承诺后揭晓"的时间属性
（hash 与 seed 同包：`src/campaign.js:337-340`）。重构为标准的
**承诺—揭晓（commit-reveal）+ 服务端签名回执**：

1. **承诺阶段（begin，刮开之前）**：服务端生成 `seed`，先算
   `commitment = SHA256(seedHex || '|' || campaignId || '|' || cardId
   || '|' || weightsVersion)`，对承诺连同上下文做 Ed25519 签名，
   只把 `commitment + commitSig + expiresAt` 给客户端并可被客户端留存
   （localStorage 允许存承诺：它不含任何可推出结果的信息）。
2. **揭晓阶段（reveal，刮开后）**：服务端才下发
   `seedHex + prize + weightsVersion + receiptSig`。
3. **客户端/第三方可做的只读核验**（不触碰未揭晓数据）：
   - 重算 `SHA256(seedHex||上下文)` 必须等于 begin 时保存的 `commitment`；
   - 用 `GET /api/verification-key` 的 Ed25519 公钥验证 `receiptSig` 与
     `commitSig`，确认承诺与回执来自同一服务端密钥、内容未被改；
   - 按**公开的、按版本固化的权重表**重算 `draw(weightsVersion, seedHex)==prize`
     （权重表在揭晓后才需要公开；服务端可经 receipt 或单独接口提供
     `weightsVersion` 对应的权重快照，签名一并提供，防偷换权重）。
4. **由此保证的性质**：
   - 服务端**不能在用户刮开后调换结果**（承诺已先固定并签名）；
   - 客户端在揭晓前**无法获知结果**（128bit seed 不可枚举，承诺不泄露奖品）；
   - 算法/权重**可在事后公开复核**（签名绑定 weightsVersion）。
5. **诚实的能力边界**（见第 6 节）：承诺方案证明"这一张卡的结果在刮开前
   已定且未被调换"，但**不能单独证明**服务端当初是均匀无偏地抽 seed
   （恶意服务端仍可选择性地只发布"输"的承诺，即选择性开奖/拒绝服务）。
   要更强需引入链上锚定或可公开审计的抽奖日志，超出本次范围。
- 退役项：FNV-1a 32bit 不再用作安全承诺（`src/lib/randomness.js:23-31`
  在该路径停用）；32bit mulberry32 的 seed 长度不足，服务端 RNG 用
  128bit；若仍用 mulberry32 风格算法做"可重算展示"，服务端可截取
  seed 的前 32bit 喂 mulberry32 以保持可复算性，但**真实抽签熵来自
  128bit seed + 服务端权重摇奖**，且算法细节与 weightsVersion 一起签名公开。

### 4. 前端改造（设计级规定，不写实现）

#### 4.1 状态机字段（以服务端凭证驱动）

- 每个活动在前端只持有服务端返回的**公开视图**，卡字段对齐第 1 节：
  `status / rev / commitment? / prize? / receipt? / expiresAt?`。
- 前端附加的纯 UI 态（不持久秘密）：
  `ui:{ scratching:boolean, busy:'begin'|'reveal'|'claim'|null,
  offline:boolean, coverage:number }`。
- 不再有本地的 `seed/seedHash/chanceSpent/chancesUsed` 真相字段；
  剩余次数只来自响应的 `chancesLeft`。
- 状态来源单一化：所有动作后用服务端响应更新；进入页面/回前台/
  收到跨页提示后用 `GET /api/state`（或 `/api/recover`）对齐。

#### 4.2 渲染门控（关键：未揭晓绝不进 DOM/内存）

- **奖品文本节点在 status 未到 revealed 之前根本不创建/不填充**：
  替换现状 `src/card.js:129-137` 的"begin 后立即写 prizeName"行为。
  未揭晓时奖品层只渲染固定占位（"刮开涂层 揭晓好礼"，对应现状占位
  `src/card.js:134-136`），`prize-name` 留空或不存在。
  仅在收到 reveal 成功响应后才 `textContent = prize.name`。
- **内存门控**：API 客户端在 begin 路径上把响应原样存入公开视图前，
  做白名单过滤/类型校验（防御性：即便服务端误带 `seed` 也不落内存视图）；
  未揭晓卡对象中出现 `prize/seed/receipt` 视为协议错误并丢弃该卡更新。
  （纵深防御，不是替代服务端正确性。）
- 涂层保持现状视觉机制（上层 canvas 覆盖：`src/style.css:266-275`），
  但"遮挡"不再承担安全职责，只做动画；未揭晓时下层本来就没有奖品内容。
- 公平性面板（现状 `src/main.js:149-167`）只对已揭晓卡启用：
  展示 commitment 比对、公钥验签、用 seedHex 重算；未揭晓卡无入口。

#### 4.3 localStorage 允许 / 禁止清单

允许（均不含未揭晓结果）：

- 会话无关的 UI 偏好（主题、是否看过引导等）。
- **承诺存档**用于公平性核对：`{campaignId,cardId,commitment,commitSig,
  weightsVersion, day, rev}`——承诺不可推出 seed/奖品。
- 已**揭晓/已领取**卡的公开视图缓存（含 prize/receipt）用于离线只读展示
  （这些本来已对该用户公开）。
- `/api/verification-key` 公钥缓存。

禁止（一票否决项）：

- 未揭晓卡的 `seed`、`seedHex`、`prize`、任何可由其重算结果的中间量；
- 服务端内部错误里若意外带秘密，前端不得持久化；
- 本地 `chancesUsed/seedHash(FNV)/weights` 摇奖副本等可被改写为
  "本地开奖"的状态；前端代码路径中不得保留"收到 seed → 本地 draw"的分支。
- 旧 v1/v2 信封（`scratch-campaign:v2:*`、`scratch-campaign-v1`）
  在迁移完成后必须删除；迁移前仅临时读取，迁移请求完成即
  `removeItem`（迁移期间页面处于只读锁定，见第 5 节）。

前端不再把整份业务信封当真相源：现状的 `createKvBackend`
（`src/storage/backend.js`）业务 key 用法应被替换/停用；可保留该通用
KV 能力存"允许清单"里的非敏感项，但**不得再存含未揭晓结果的信封**。

#### 4.4 跨标签页同步

- 真相在服务端：多标签页不再互相从 localStorage 拉未揭晓信封
  （废弃 `src/campaign.js:232-240` 那种整包拉取在该路径的使用）。
- 保留轻量提示通道（BroadcastChannel / storage 事件，
  `src/storage/sync.js:118-183` 可复用其通道骨架）：消息只带
  `{type:'dirty', campaignId, cardId, rev}`，**不含任何结果字段**。
- 收到提示的标签页调用 `GET /api/state?campaign=` 对齐公开视图。
- 回前台（`visibilitychange`，现状 `src/campaign.js:274-276`）与
  定时轮询（频率可低，如 15–30s，仅为跨天/他页领取兜底）同样走 /state。
- 两页并发 begin/claim 的正确性由服务端幂等/原子裁决（2.5），
  前端在收到 `already-pending/already-claimed/conflict` 时拉 /state 对齐，
  不做本地 CAS 裁决。

#### 4.5 网络延迟与失败的交互

- 与现状一致采用"先授权后擦除"（现状 `src/card.js:64-75`、
  `src/scratch-layer.js:301-351` 的 pending 缓冲思路保留）：
  pointerdown 时先 `await begin`；请求中涂层不产生可见擦除（缓冲或禁用），
  成功才允许刮，失败提示不擦除，避免乐观 UI 回滚。
- 刮到阈值（现状 60%：`src/card.js:16,76-97`）→ 调 reveal：
  reveal 成功前不淡出涂层、不弹结果；显示"揭晓中…"。
  reveal 失败按错误码处理：网络错误保留进度并提供"重试揭晓"，
  **绝不本地补一个结果**；卡片仍是服务端 pending，刷新可恢复。
- claim：按钮置 busy；网络错误可重试（幂等键不变）；`already-claimed`
  则同步为已领取并提示（对齐现状文案 `src/main.js:130-137`）。
- 超时/5xx：区分"不知道服务端是否已处理"——一律用**同一幂等键重试**
  或 GET /state 查询，不允许本地推进状态。
- 所有写操作必须在 UI 上串行防重复提交（按钮禁用/单飞），但安全去重
  以服务端幂等键为准。

### 5. 降级与迁移

#### 5.1 服务端不可达：只读 / 锁定，禁止本地摇奖（硬性）

- 健康检查/请求失败进入 **offline 模式**（顶部横幅，类似现状存储提示位
  `src/main.js:53-55,243`，但语义改为"服务端不可用"）。
- 允许：
  - 浏览"允许清单"缓存中**已揭晓/已领取**的只读内容（展示奖品/凭证，
    但 claim/reveal 按钮禁用）；
  - 查看缓存的承诺、做已揭晓卡的验签复核（纯本地、只读）。
- 禁止（任何降级路径都不允许）：
  - begin / reveal / claim 的**本地替代开奖**；不调用 `generateSeed/drawPrize`
    去产生结果；不接受任何"先本地开了以后同步"的模式；
  - 不改写本地剩余次数、不根据本地时钟跨天发放次数。
- 交互：未进行中的卡显示"网络不可用，暂时无法刮卡"；进行中（已 begin
  但未 reveal，且离线）卡保持涂层，提示"已占用本次机会，恢复网络后可继续
  刮开（结果已定，不会重摇）"。恢复网络后先 GET /state 再允许动作。
- `localStorage` 不可用（现状内存降级：`src/storage/backend.js:59-73`）
  与服务端方案正交：无本地缓存时退化为"在线才能用、无离线只读缓存"，
  依然不得本地开奖。

#### 5.2 旧本地数据迁移与"已刮开未领取"防重复领取

现状本地存在两类需要处理的数据：旧 v1 信封（`scratch-campaign-v1`，
见 `src/lib/migration.js:71-108`）与 v2 信封（`scratch-campaign:v2:<id>`，
结构见 `src/lib/migration.js:4-16`），其中可能含
idle / scratching / revealed / claimed 各态（状态机定义
`src/lib/state-machine.js:111-116`；scratching 刷新归一 idle
`src/lib/state-machine.js:212-224`）。

迁移流程（首次进入且检测到旧 key 时）：

1. 页面进入**只读锁定**：不允许新 begin；展示"正在迁移历史记录"。
2. 读取旧信封（客户端只是搬运，不据此开奖），整包 POST 到
   `/api/migrate/import`，带 `Idempotency-Key`（如
   `migrate:<sha256(payload)>`），服务端登记后客户端 `removeItem`
   两个旧 key，成功后解除锁定、GET /state 对齐。
3. 服务端按卡分类处理（**信任边界：客户端自报数据默认可伪造**，见第 6 节）：
   - **claimed**：只作为"历史已领取/已结算"登记进 `claimsLedger`，
     以稳定去重键（优先旧信封中无 seed 时用 `campaignId#cardId#day#prizeName`
     + 会话/迁移批次）防同一份数据被二次导入重复发奖；幂等键保证同一
     payload 重复提交只生效一次。**不补发、不新增任何可领额度**。
   - **revealed（已刮开未领取，含中奖）**：服务端登记为该会话的
     `revealed` 待领记录（可进入正常 claim），同样进 `claimsLedger`
     去重索引；claim 时走 1.4 的原子先到先得 + 幂等，领取成功后该去重键
     永久标记，防止"导入→领取→改本地数据/换浏览器再导入→再领"。
     - 为降低"伪造一条中奖 revealed 再导入"的风险（客户端数据本可手改，
       见 L6/第 6 节）：迁移窗口设截止（仅升级后限定时间/限定版本接受），
         并对迁移中奖记录做服务端速率/总量封顶；超出按"历史展示，不可领取"
         处理并明确告知。是否承认历史中奖本质是业务信任决策，文档必须显式。
   - **pending/scratching/idle 但 chanceSpent（已扣费未揭晓，本地带 seed/prize）**：
     这是本地开奖数据，**结果已提前抵达客户端，无法再满足安全目标**。
     两种策略，二选一并在实现前确认（本设计推荐 B）：
     - A. 承认其本地 seed/prize，导入为服务端 pending 继续刮（安全上该卡
       已"破功"，用户早已能从 localStorage 读到，见 1.1/L1）；
     - B.（推荐）**作废为只读历史、不导入可玩结果、不退还也不重摇**，
       当日次数按"已消耗"计或由服务端按迁移日重新发放（产品决策），
       从迁移完成起所有新卡一律服务端开奖。推荐 B，因为 A 会把
       "客户端可自造 seed/prize"的污染状态带入权威账本。
   - **idle 且未 chanceSpent**：无结果可迁，直接丢弃本地记录，
     新一天/当前卡由服务端账本接管。
4. 多标签页迁移：迁移锁由服务端迁移幂等键 + 客户端单飞（只允许一个标签页
   执行 import，其余标签页等待并最终 GET /state）保证；旧 key 删除通过
   storage 事件通知他页（复用 `src/storage/sync.js` 的通知骨架）。
5. 迁移失败（网络）：保留旧 key 不删、页面维持只读锁定、允许重试；
   **绝不因迁移失败而走本地开奖兜底**。

### 6. "本方案防不住什么"（信任边界，禁止夸大）

- **信任服务端本身**：本方案把信任边界从"每个用户的浏览器"收敛到"服务端"。
  能读服务端内存/JSONL/私钥的人（运维、被入侵主机、恶意服务端代码）可见
  未揭晓结果并可开奖；承诺—揭晓能阻止**事后调换已承诺结果**，但阻止不了
  服务端**选择性地只让用户输**（选择性发承诺）或在发承诺前就偏心生成 seed。
- **防不住客户端恶意/被入侵终端在"揭晓之后"的行为**：reveal 后结果本就要
  显示给用户；终端上的木马、录屏、被劫持扩展能看到已揭晓内容，也能冒用
  cookie 操作（cookie 已用 HttpOnly/SameSite 降低 XSS 窃取面，但无法防御
  完全受控的终端）。
- **历史本地数据不可被密码学证明为真**：旧 localStorage 自报的中奖/待领
  记录可被用户任意伪造（L6）。迁移只能靠"窗口 + 限量 + 去重"控制滥用，
  无法从技术上鉴别一条本地中奖是否真实发生（现状没有任何服务端凭证）。
- **不防服务端拒绝服务 / 可用性攻击**：服务端宕机即不可玩（设计上宁可
  不可玩也不本地开奖）；内存单实例 + JSONL 的模拟实现没有高可用/水平扩展
  承诺。
- **承诺方案不等于"全局可证明公平"**：没有外部锚定时，无法向第三方证明
  长期开奖分布符合公示权重；这需要链上提交/公开抽奖日志等额外设施。
- **网络层**：dev 为明文 HTTP，cookie 不带 Secure；生产必须 HTTPS，
  否则中间人可读取/改写（含已揭晓结果、劫持会话）。本设计只覆盖同源 HTTP API。
- **侧信道不在范围**：服务端日志/崩溃上报/APM 若实现不当仍可能带出
  seed/prize（已在验收中要求"错误体与日志不含秘密"，但依赖实现遵守）；
  浏览器扩展、DevTools 断点读取 reveal 之后的内存属于揭晓之后，不在
  "提前抵达"威胁模型内。
- **算法保留 mulberry32 仅为可复算演示**：若服务端真实抽签直接用
  mulberry32(截断的 seed)，其分布质量与"可选择性输出"风险仍在；
  安全抽签熵来自 `crypto.randomBytes(128bit)`，算法选择应在实现评审中
  明确，且 weightsVersion + 签名允许事后复核具体一次开奖。

### 7. 验收清单（每条均可落地为 `node --test` 断言）

> 说明：A 类为服务端纯逻辑/HTTP 断言（`node --test server/*.test.js`，
> 注入内存 store + 假时钟 + 测试签名密钥，对 `createServerApp` 发请求）；
> B 类为前端/打包断言（可用 jsdom/手工 fetch 桩，或对 build 产物做
> 字符串/数据流断言）。下列每条给出可直接转化为 `assert` 的判定。

**A. 不提前抵达（核心安全目标）**

1. begin 响应体不含未揭晓秘密：对一张卡 begin 成功后，
   `assert !('seed' in body.card) && !('seedHex' in body.card) &&
   !('prize' in body.card) && !('receipt' in body.card)`；
   且 `typeof body.card.commitment === 'string'`（64 位 hex）。
2. 全响应深度扫描：对 begin/state/recover 的原始 JSON 字符串断言
   `assert !raw.includes(服务端该卡真实 seedHex)` 且不含任何奖品名
   `assert prizes.every(p => !raw.includes(p.name))`（pending 状态下）。
3. GET /state 与 /api/recover 对 pending 卡同样只暴露 commitment：
   遍历返回 cards，`pending => 仅有 commitment`，`assert !card.prize`。
4. 只有 reveal 成功响应第一次包含 prize/receipt：reveal 前任意接口都不含；
   reveal 响应 `assert.equal(body.card.prize.name, 服务端记录的 prize.name)`
   且 `assert.equal(body.card.receipt.seedHex, record.seedHex)`。
5. localStorage 禁止项（B，jsdom 或集成环境）：执行 begin 后扫描
   全部 localStorage 值，断言无 seedHex/奖品名：
   `Object.values(localStorage).every(v => !v.includes(seedHex))`，
   且 pending 时 `every(v => !prizeNames.some(n=>v.includes(n)))`。
6. DOM 门控（B）：begin 成功但未 reveal 时，
   `assert.equal(cardEl.querySelector('.prize-name').textContent, '')`
   （占位/空），奖品名不出现在 `cardEl.textContent`；reveal 后才出现。
7. 前端 bundle 无摇奖能力（B）：对 `vite build` 产物断言
   - 不含未揭晓用的权重摇奖调用（可通过模块边界测试：未揭晓路径代码里
     不存在"由 seed 得到 prize"的函数引用；用依赖图/源码断言
     `src` 的 begin 链路不 import 服务端 `weights/draw`）；
   - 前端不 import 任何 `server/**`（构建依赖图断言）。
8. 日志/错误体不泄密（A）：触发各类 4xx/5xx（坏 JSON、unknown-card、
   no-chances、invalid-state），断言错误响应体与捕获的服务端日志字符串
   均不含 `seedHex/prize.name`。

**B. 幂等 / 并发 / 记账原子性**

9. begin 幂等：同一 `Idempotency-Key` 连发两次 begin，
   两次 commitment/rev 相同，`days.chancesUsed` 只增加 1。
10. 双页并发 begin（同 sid/card，不同 key）：并发发 N 个请求，
    `assert.equal(成功新建 pending 数, 1)`，最终 `chancesUsed` 恰为 1，
    其余响应 `reason==='already-pending'` 且返回同一 commitment。
11. 次数上限：构造已用满 `dailyChances` 的账本，再 begin
    `assert.equal(body.ok,false)` 且 `body.reason==='no-chances'`，
    不创建卡、不增加 chancesUsed。
12. reveal 幂等：连续 reveal 两次（含不同 key），返回 prize/receipt 完全相同，
    状态保持 revealed，不产生第二事件（JSONL 中该卡只有一次 revealed 事件）。
13. claim 先到先得：两个并发 claim，恰好一个 `ok:true`，另一个
    `reason==='already-claimed'`；终态 claimed；`claimsLedger` 恰一条。
14. claim 响应丢失后重放：用同一幂等键再 claim，返回同一 `claimRef`，
    不重复发奖（领奖计数不变）。
15. 状态机非法迁移：对 idle 调 reveal/claim、对 revealed 调 begin、
    对 claimed 调 reveal 得新结果等，断言对应 `invalid-state/...` 且
    seed/prize 不被改变、次数不变。

**C. 时钟 / 跨天 / 回拨**

16. 服务端跨天：day1 用满次数，把注入时钟拨到次日，begin 成功且使用新账本
    （chancesUsed 归 0、chancesLeft 恢复）；前一天 claimed 卡仍为 claimed。
17. 客户端改时间无效（B/A 边界）：请求体里即便带伪造本地时间（或前端
    Date 被拨），服务端剩余次数/授权结果只随服务端注入时钟变化。
18. 服务端时钟回拨：把 clock 回退若干小时/一天，断言不恢复已用次数、
    day 账本不回退（沿用更晚已记账日），记录 `clockAnomaly`，
    pending 卡仍可用原 seed 完成 reveal。

**D. 承诺—揭晓与签名**

19. 承诺绑定：用 reveal 返回的 seedHex/上下文重算 SHA-256，
    `assert.equal(recomputed, beginCommitment)`；篡改任一上下文
    （cardId/weightsVersion）重算应不等。
20. 回执验签：用 `/api/verification-key` 公钥
    `assert(verify(publicKey, canonicalReceiptBytes, receipt.signature))`；
    篡改 prize 后验签失败。
21. 承诺先于结果（时间属性）：断言服务端 commitment 的生成事件序号
    严格早于任何包含 seed/prize 的下发事件；且 begin 响应不含 seed。
22. seed 强度：`assert.equal(Buffer.from(seedHex,'hex').length, 16)`（128bit）；
    连续生成大量 seed 无重复（唯一性断言，如 1e5 个无碰撞）。
23. 权重版本固化：receipt 中 weightsVersion 与服务端记录一致；
    人为切换权重表后，旧卡 reveal 仍按 begin 时版本开奖（结果与旧权重一致）。

**E. 降级 / 迁移**

24. 离线禁止本地开奖（B）：拦截所有 /api 请求失败，模拟刮卡，
    断言：不产生任何 seed/prize、不新增 localStorage 秘密项、
    reveal/claim/begin 按钮不可成功（无本地结果写入），出现只读/锁定提示。
25. pending 恢复：begin 成功后不 reveal 直接刷新（调 /api/recover），
    卡为 pending 且承诺一致、机会已扣；随后 reveal 得到的 prize 与
    首次 begin 时服务端记录一致（不重摇、不退次）。
26. 迁移幂等：同一份旧信封以同一迁移 key 调 import 两次，
    claimsLedger 新增条目只算一次；第二次返回幂等结果，不产生新待领。
27. 迁移防重领：导入一条 revealed 中奖 → claim 成功 → 再次导入同一数据，
    断言不能第二次领取（`already-claimed`/去重命中），领奖总数为 1。
28. 迁移旧 key 清理（B）：成功 import 后断言
    `localStorage.getItem('scratch-campaign-v1')===null` 且
    `localStorage.getItem('scratch-campaign:v2:daily')===null`；
    import 失败时旧 key 仍保留且页面锁定。
29. 未消费 idle 卡不污染：idle 且 chanceSpent=false 的旧卡迁移后不产生
    任何可玩结果/额度，服务端无对应 pending 记录。

**F. 工程约束**

30. 零第三方运行时依赖：服务端代码 import 仅来自 `node:` 内置
    （静态扫描断言，无裸模块依赖）；`package.json` 运行时 dependencies 不新增。
31. 前后端隔离：前端源码不出现 `from '*/server/*'`；服务端模块可被
    `node --test` 独立 import 且不需要 DOM/Vite。
32. 基线不回归：在仅新增文档（本次）与后续按设计实现后，
    `npm test` 全绿、`npm run build` 成功；dev 下通过真实 HTTP
    （vite middleware）可完成 begin→reveal→claim 全链路。

---

### 附：与现状代码的主要替换映射（供实现阶段索引）

| 现状 | 服务端化后 |
|---|---|
| `src/campaign.js:326-341` 本地 beginScratch（本地生成 seed/摇奖/扣次） | `POST /api/.../scratch/begin`（服务端），前端只存承诺 |
| `src/lib/state-machine.js:160-182` transitionBegin | 服务端 begin 事务（2.3/2.4） |
| `src/lib/randomness.js:57-72` generateSeed（32bit） | 服务端 `randomBytes(16)`（2.7） |
| `src/lib/randomness.js:23-31` FNV-1a 承诺 | 服务端 SHA-256 commitment + Ed25519 签名（第 3 节） |
| `src/campaign.js:343-365` reveal/claim + 本地 CAS | reveal/claim API + 服务端原子裁决（1.3/1.4/2.5） |
| `src/campaign.js:371-389` 客户端 verify | 揭晓后只读核验：commitment/验签/公开权重重算（第 3 节） |
| `src/campaign.js:129-163,184-230` 锁+CAS | 服务端按会话串行 + rev 乐观字段（2.3） |
| `src/lib/time.js:150-170`、`src/campaign.js:279-290` 本地跨天/回拨 | 服务端时钟与 day 账本（2.6） |
| `src/storage/backend.js` 存整份信封 | localStorage 仅存"允许清单"，真相在服务端（4.3） |
| `src/storage/sync.js:137-143`、`src/campaign.js:232-240` 拉整包 | 仅传 rev 提示 + GET /state 公开视图（4.4） |
| `src/card.js:129-137` 未揭晓已写 prize DOM | 未揭晓不创建/不填充奖品文本（4.2） |
| `src/lib/migration.js:42-109` 本地迁移 | `/api/migrate/import` + 去重/限量/清理（5.2） |

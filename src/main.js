/**
 * 入口：组装页面骨架，创建活动控制器与卡片列表。
 * 职责边界：只做装配，不含业务规则与渲染细节。
 */

import './style.css'
import { createCampaignController } from './campaign/controller.js'
import { createCardView } from './campaign/cardView.js'
import { remainingAttempts, DAILY_ATTEMPTS } from './campaign/stateMachine.js'

const CARD_IDS = ['card-1', 'card-2', 'card-3']

const controller = createCampaignController()

const app = document.querySelector('#app')

const header = document.createElement('header')
header.className = 'page-header'
const title = document.createElement('h1')
title.textContent = '幸运刮刮卡'
const attempts = document.createElement('p')
attempts.className = 'attempts'
attempts.setAttribute('aria-live', 'polite')
header.append(title, attempts)

const list = document.createElement('main')
list.className = 'card-list'
for (const id of CARD_IDS) {
  list.appendChild(createCardView(controller, id))
}

app.append(header, list)

function renderAttempts(state) {
  attempts.textContent = `今日剩余刮卡次数：${remainingAttempts(state)} / ${DAILY_ATTEMPTS}`
}
controller.subscribe(renderAttempts)
renderAttempts(controller.getState())

/**
 * 活动控制器。
 * 职责边界：连接纯逻辑状态机与持久化层，向 UI 发布状态变更；不操作 DOM。
 */

import {
  normalizeState,
  startScratch,
  completeReveal,
  claimPrize,
} from './stateMachine.js'
import { loadState, saveState } from './storage.js'

export function createCampaignController() {
  let state = normalizeState(loadState())
  const listeners = new Set()

  function emit() {
    for (const fn of listeners) fn(state)
  }

  function apply(result) {
    if (result.ok && result.state !== state) {
      state = result.state
      saveState(state)
      emit()
    }
    return result
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    startScratch: (cardId) => apply(startScratch(state, cardId)),
    completeReveal: (cardId) => apply(completeReveal(state, cardId)),
    claim: (cardId) => apply(claimPrize(state, cardId)),
  }
}

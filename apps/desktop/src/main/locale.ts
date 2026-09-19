// locale.ts — Electron 侧的 locale 信号采集。
//
// 判定策略本身在 src/locale.ts（宿主无关纯函数）；本文件只负责把主进程能拿到的
// OS 信号喂进去。浏览器形态没有这条通路，在 renderer/src/browser.ts 里用
// navigator.languages 自行采集同一个 LocaleSignals 结构。

import { app } from 'electron'

import { detectPreferenceLanguage, readTimeZone } from '../locale'
import type { LocaleSignals } from '../locale'
import type { PreferenceLanguage } from '../preferences'

export function collectLocaleSignals(): LocaleSignals {
  // getPreferredSystemLanguages 在部分 Linux 桌面会返回空数组，此时退回单一 getLocale。
  const preferred = app.getPreferredSystemLanguages()
  return {
    timeZone: readTimeZone(),
    languages: preferred.length ? preferred : [app.getLocale()]
  }
}

/** 首次运行（无已持久化选择）时的默认界面语言。 */
export function detectRendererLanguage(): PreferenceLanguage {
  return detectPreferenceLanguage(collectLocaleSignals())
}

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
  return {
    timeZone: readTimeZone(),
    languages: app.getPreferredSystemLanguages(),
  }
}

export function detectRendererLanguage(): PreferenceLanguage {
  return detectPreferenceLanguage(collectLocaleSignals())
}

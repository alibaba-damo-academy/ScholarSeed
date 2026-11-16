import type { Theme } from '@openuidev/react-ui'
import { useEffect, useState } from 'react'

const CHART_PALETTE = [
  'var(--vds-chart-series-1)',
  'var(--vds-chart-series-2)',
  'var(--vds-chart-series-3)',
  'var(--vds-chart-series-4)',
  'var(--vds-chart-series-5)',
  'var(--vds-chart-series-6)',
  'var(--vds-chart-series-7)',
  'var(--vds-chart-series-8)',
]

export function useConversationMode(): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setMode(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
    )
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  return mode
}

export const conversationTheme: Theme = {
  background: 'transparent',
  foreground: 'var(--vds-bg-white-default)',
  textNeutralPrimary: 'var(--vds-text-primary)',
  textNeutralSecondary: 'var(--vds-text-secondary)',
  textNeutralTertiary: 'var(--vds-text-tertiary)',
  borderDefault: 'var(--vds-border-default)',
  interactiveAccentDefault: 'var(--vds-brand-bg-default)',
  fontBody: 'var(--vds-font-main)',
  fontCode: 'var(--vds-font-code)',
  fontNumbers: 'var(--vds-font-main)',
  fontHeading: 'var(--vds-font-main)',
  fontLabel: 'var(--vds-font-main)',
  fontSizeMd: 'var(--vds-font-body-lv2)',
  fontSizeSm: 'var(--vds-font-body-lv1)',
  lineHeightBody: 'var(--vds-lh-body-lv2)',
  spaceXs: 'var(--vds-space-1)',
  spaceS: 'var(--vds-space-2)',
  spaceSM: 'var(--vds-space-3)',
  spaceM: 'var(--vds-space-4)',
  spaceML: 'var(--vds-space-5)',
  spaceL: 'var(--vds-space-6)',
  radiusM: 'var(--vds-radius-4)',
  radiusL: 'var(--vds-radius-8)',
  defaultChartPalette: CHART_PALETTE,
  barChartPalette: CHART_PALETTE,
  lineChartPalette: CHART_PALETTE,
  areaChartPalette: CHART_PALETTE,
  pieChartPalette: CHART_PALETTE,
  radarChartPalette: CHART_PALETTE,
  radialChartPalette: CHART_PALETTE,
  horizontalBarChartPalette: CHART_PALETTE,
}

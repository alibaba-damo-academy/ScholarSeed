import type { TFunction } from 'i18next'
import type { DeliveryCard, DeliveryCardMember } from './model'

export function deliveryMemberTitle(member: DeliveryCardMember, t: TFunction<'conversation'>): string {
  return member.titleFallback ? t('delivery.untitled') : member.title
}

export function deliveryLabel(delivery: DeliveryCard, t: TFunction<'conversation'>): string {
  if (delivery.labelFallback === 'current') return t('delivery.current')
  if (delivery.labelFallback !== 'legacy') return delivery.label
  const primary = delivery.members.find((member) => member.primary) ?? delivery.members[0]
  return t('delivery.legacy', { title: primary ? deliveryMemberTitle(primary, t) : '' })
}

export function documentDisplayTitle(tab: { title: string; titleFallback?: 'untitledArtifact' | { kind: 'reviewBaseline'; filename: string } }, t: TFunction<'conversation'>, workbench: TFunction<'workbench'>): string {
  if (typeof tab.titleFallback === 'object' && tab.titleFallback.kind === 'reviewBaseline') return workbench('snapshot.baselineTitle', { title: tab.titleFallback.filename })
  return tab.titleFallback === 'untitledArtifact' ? t('delivery.untitled') : tab.title
}

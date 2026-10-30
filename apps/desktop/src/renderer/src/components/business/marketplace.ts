import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  clearMarketplaceCache,
  getMarketplace,
  getMarketplaceDetail,
  getMarketplaceLabels,
  installMarketplaceSkill,
  updateMarketplaceSkill,
  SKILL_ERROR_DUPLICATE,
  type MarketplaceDetail,
  type MarketplacePage,
  type MarketplaceSkill,
  type SkillInfo,
  type SkillLabel,
} from '../../api'
import { useToast } from '../ui'

export function useSkillUpdates(skills: SkillInfo[], onUpdated: () => Promise<void>) {
  const { t } = useTranslation('skills')
  const { toast } = useToast()
  const locked = React.useRef(false)
  const [updating, setUpdating] = React.useState<string | null>(null)
  const available = skills.filter(
    (skill) =>
      skill.group === 'user' &&
      skill.hub?.source === 'clawhub' &&
      skill.updateStatus === 'available' &&
      skill.latestVersion &&
      skill.hub.version
  )
  const update = async (candidates: SkillInfo[]): Promise<void> => {
    if (locked.current || !candidates.length) return
    locked.current = true
    let succeeded = 0
    const failed: string[] = []
    try {
      for (const skill of candidates) {
        setUpdating(skill.name)
        const result = await updateMarketplaceSkill(skill)
        if (result.ok) succeeded += 1
        else failed.push(skill.display_name || skill.name)
      }
      await onUpdated()
      toast({
        tone: failed.length ? 'error' : 'success',
        title: t('updates.result', { succeeded, failed: failed.length }),
        description: failed.length
          ? t('updates.failedItems', { names: failed.join(', ') })
          : undefined,
      })
    } finally {
      setUpdating(null)
      locked.current = false
    }
  }
  return { available, updating, update }
}

export function useMarketplace({
  enabled,
  query,
  skills,
  onInstalled,
}: {
  enabled: boolean
  query: string
  skills: SkillInfo[]
  onInstalled: () => Promise<void>
}) {
  const { t, i18n } = useTranslation('skills')
  const locale = i18n.resolvedLanguage || i18n.language
  const { toast } = useToast()
  const [catalogue, setCatalogue] = React.useState<MarketplacePage | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [revision, setRevision] = React.useState(0)
  const [labels, setLabels] = React.useState<SkillLabel[]>([])
  const [label, setLabel] = React.useState('')
  const [labelsLoading, setLabelsLoading] = React.useState(true)
  const [labelsFailed, setLabelsFailed] = React.useState(false)
  const [installing, setInstalling] = React.useState<string | null>(null)
  const [selected, select] = React.useState<MarketplaceSkill | null>(null)
  const [detail, setDetail] = React.useState<MarketplaceDetail | null>(null)
  const [detailFailed, setDetailFailed] = React.useState(false)
  const generation = React.useRef(0)
  const pagination = React.useRef<number | null>(null)
  const normalizedQuery = query.trim()

  React.useEffect(() => {
    let current = true
    setLabelsLoading(true)
    setLabelsFailed(false)
    void getMarketplaceLabels(locale).then(
      (items) => {
        if (!current) return
        const categories = items.filter((item) => item.type === 'RECOMMENDED')
        setLabels(categories)
        setLabelsLoading(false)
      },
      () => {
        if (!current) return
        setLabelsFailed(true)
        setLabelsLoading(false)
        toast({ tone: 'error', title: t('classification.failed') })
      }
    )
    return () => {
      current = false
    }
  }, [locale, revision, toast, t])

  React.useEffect(() => {
    if (labelsLoading || labelsFailed || !label || labels.some((item) => item.slug === label))
      return
    setLabel('')
    toast({ tone: 'info', title: t('classification.removed') })
  }, [labels, labelsLoading, labelsFailed, label, toast, t])

  React.useEffect(() => {
    if (!enabled) return
    const request = ++generation.current
    pagination.current = null
    setLoading(true)
    setFailed(false)
    setCatalogue(null)
    void getMarketplace(normalizedQuery, '', label, locale).then(
      (page) => {
        if (request !== generation.current) return
        setCatalogue(page)
        setLoading(false)
      },
      () => {
        if (request !== generation.current) return
        setFailed(true)
        setLoading(false)
      }
    )
    return () => {
      generation.current += 1
    }
  }, [enabled, normalizedQuery, label, locale, revision])

  React.useEffect(() => {
    let current = true
    setDetail(null)
    setDetailFailed(false)
    if (selected) {
      void getMarketplaceDetail(selected.slug, selected.version, locale).then(
        (value) => {
          if (current) setDetail(value)
        },
        () => {
          if (current) setDetailFailed(true)
        }
      )
    }
    return () => {
      current = false
    }
  }, [selected, locale, revision])

  const installed = (skill: MarketplaceSkill): SkillInfo | undefined =>
    skills.find(
      (local) =>
        local.group === 'user' &&
        local.hub?.source === 'clawhub' &&
        Boolean(local.hub.registry) &&
        (catalogue?.registryAliases ?? [catalogue?.registry]).some(
          (registry) => registry === local.hub?.registry?.replace(/\/+$/, '')
        ) &&
        local.hub.slug === skill.slug &&
        (!skill.namespace || local.hub.namespace === skill.namespace)
    )

  const install = async (skill: MarketplaceSkill): Promise<void> => {
    if (installing || installed(skill) || !skill.version || skill.moderation === 'blocked') return
    setInstalling(skill.slug)
    try {
      const result = await installMarketplaceSkill(skill.slug, skill.version)
      if (!result.ok) {
        toast({
          tone: 'error',
          title: t(
            result.code === SKILL_ERROR_DUPLICATE
              ? 'marketplace.conflict'
              : 'marketplace.installFailed'
          ),
        })
        return
      }
      await onInstalled()
      toast({
        tone: 'success',
        title: t('installed', { name: result.name || skill.name }),
      })
    } catch {
      toast({ tone: 'error', title: t('marketplace.installFailed') })
    } finally {
      setInstalling(null)
    }
  }

  const more = async (): Promise<void> => {
    if (loading || !catalogue?.nextCursor || pagination.current === generation.current) return
    const request = generation.current
    pagination.current = request
    setLoading(true)
    try {
      const page = await getMarketplace(normalizedQuery, catalogue.nextCursor, label, locale)
      if (request !== generation.current) return
      setCatalogue((current) =>
        current
          ? {
              ...page,
              items: [
                ...current.items,
                ...page.items.filter(
                  (item) => !current.items.some((existing) => existing.slug === item.slug)
                ),
              ],
            }
          : page
      )
      setFailed(false)
    } catch {
      if (request === generation.current) setFailed(true)
    } finally {
      if (pagination.current === request) pagination.current = null
      if (request === generation.current) setLoading(false)
    }
  }

  return {
    labels,
    label,
    setLabel,
    labelsLoading,
    labelsFailed,
    catalogue,
    loading,
    failed,
    installing,
    selected,
    detail,
    detailFailed,
    installed,
    install,
    more,
    select: (skill: MarketplaceSkill | null) => {
      select(skill)
    },
    refresh: () => {
      clearMarketplaceCache()
      setRevision((value) => value + 1)
    },
    retryDetail: () => select((value) => (value ? { ...value } : null)),
  }
}

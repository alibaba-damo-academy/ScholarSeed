import type { TFunction } from 'i18next'

export function officeFailureLabels(t: TFunction<'workbench'>): Record<string, string> {
  return {
    office_fonts_unreadable: t('officeFrame.fontsEmpty'),
    office_cells_protected: t('officeError.cells_protected'),
    office_workbook_protected: t('officeError.workbook_protected'),
    office_formula_rejected: t('officeError.formula_rejected'),
    office_structure_rejected: t('officeError.structure_rejected'),
    office_finish_editing: t('officeError.finish_editing'),
    office_undo_failed: t('officeError.undo_failed'),
    office_protection_failed: t('officeError.protection_failed'),
    office_image_invalid: t('officeError.image_invalid'),
    office_image_failed: t('officeError.image_failed'),
    office_editing_unavailable: t('officeError.editing_unavailable'),
    office_document_unavailable: t('officeError.document_unavailable'),
    office_policy_failed: t('officeError.policy_failed'),
    office_formula_policy_failed: t('officeError.formula_policy_failed'),
    office_image_pending: t('officeError.image_pending'),
    office_image_permission: t('officeError.image_permission'),
    office_reveal_changed: t('officeError.reveal_changed'),
    office_reveal_missing: t('officeError.reveal_missing'),
    office_reveal_timeout: t('officeError.reveal_timeout'),
    office_paste_failed: t('officeError.paste_failed'),
  }
}

export function officeFailureText(message: string, t: TFunction<'workbench'>): string {
  const labels = officeFailureLabels(t)
  const code = message.startsWith('Error: ') ? message.slice('Error: '.length) : message
  return Object.prototype.hasOwnProperty.call(labels, code)
    ? labels[code] : t('officeError.unknown', { detail: message })
}

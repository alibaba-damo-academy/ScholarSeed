import { useTranslation } from 'react-i18next'
import { OfficeImageError, OFFICE_IMAGE_BYTES_PER_MIB, OFFICE_IMAGE_MAX_BYTES, OFFICE_IMAGE_MAX_PIXELS } from '../../../../images'
import { createFormatters } from '../../../../localization/format'
import { ImageOperationError } from './api'

export function useImageFailureText(): (error: unknown) => string {
  const { t, i18n } = useTranslation('workbench')
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const labels = {
    stageUnsupported: t('imageError.stageUnsupported'), stageFailed: t('imageError.stageFailed'),
    releaseFailed: t('imageError.releaseFailed'), saveUnsupported: t('imageError.saveUnsupported'),
    saveFailed: t('imageError.saveFailed'), readFailed: t('imageError.readFailed')
  }
  return error => {
    if (error instanceof OfficeImageError) {
      const failure = error.failure
      const maxMiB = format.number((failure.maxBytes ?? OFFICE_IMAGE_MAX_BYTES) / OFFICE_IMAGE_BYTES_PER_MIB)
      const maxPixels = format.number(failure.maxPixels ?? OFFICE_IMAGE_MAX_PIXELS)
      const acquisition = {
        pixel_limit: t('imageAcquisition.pixelLimit', { maxPixels }),
        byte_limit: t('imageAcquisition.byteLimit', { maxMiB }),
        invalid_file: t('imageAcquisition.invalidFile', { maxMiB }),
        unreadable: t('imageAcquisition.unreadable'),
        unsupported_source: t('imageAcquisition.unsupportedSource'),
        clipboard_limit: t('imageAcquisition.clipboardLimit', { maxMiB }),
        invalid_sender: t('imageAcquisition.invalidSender'),
        read_failed: t('imageAcquisition.readFailed')
      }
      const message = acquisition[failure.code]
      return failure.message ? t('imageAcquisition.diagnostic', { message, detail: failure.message }) : message
    }
    return error instanceof ImageOperationError
    ? error.status === undefined ? labels[error.code] : t('imageError.http', { message: labels[error.code], status: error.status })
    : t('imageError.unknown', { detail: error instanceof Error ? error.message : String(error) })
  }
}

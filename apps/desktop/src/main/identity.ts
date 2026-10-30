import { SCHOLARSEED_PRODUCT_ID } from './product.ts'

// Velopack's default shortcut AUMID uses its packId (product_id), not bundle_id.
export const WINDOWS_NOTIFICATION_ID = `velopack.${SCHOLARSEED_PRODUCT_ID}`

interface NotificationApplication {
  setAppUserModelId(id: string): void
}

export function configureNotificationIdentity(
  application: NotificationApplication,
  platform: NodeJS.Platform
): void {
  if (platform === 'win32') application.setAppUserModelId(WINDOWS_NOTIFICATION_ID)
}

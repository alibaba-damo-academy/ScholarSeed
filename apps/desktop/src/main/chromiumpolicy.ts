const PRODUCT_CONTROLLED_METHODS = new Set([
  'Browser.setDownloadBehavior',
  'Page.setDownloadBehavior',
  'Browser.grantPermissions',
  'Browser.setPermission',
  'Browser.resetPermissions'
])

export function chromiumProductControlledMethod(method: string): boolean {
  return PRODUCT_CONTROLLED_METHODS.has(method)
}

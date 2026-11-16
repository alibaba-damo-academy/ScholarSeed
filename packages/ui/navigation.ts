export function denyUINavigation(): never {
  throw new Error('ui_navigation_not_authorized')
}

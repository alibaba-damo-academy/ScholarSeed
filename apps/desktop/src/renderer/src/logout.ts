import { type AccountLogoutResult, dropSession } from './account.ts'
import { postAuthLogout } from './api.ts'

const LOGOUT_REVOCATION_ERROR = '本机执行凭据清理失败，请重试退出登录。'

/**
 * 桌面端唯一注销协调器。serve logout 负责本机服务会话，cookie 清除是账号模式下
 * 结束本机登录态的硬门禁；远端 JWT 吊销需账号服务另行提供用户态接口。
 */
export async function logoutDesktopSession(): Promise<AccountLogoutResult> {
  try {
    await postAuthLogout()
  } catch (error) {
    return { ok: false, code: 'local_logout_failed', error: LOGOUT_REVOCATION_ERROR, applicationFailure: {
      code: 'logout_revocation_failed', ...(error == null ? {} : { diagnostic: error instanceof Error ? error.message : String(error) })
    } }
  }
  return dropSession()
}

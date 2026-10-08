import { getJson, postJson } from './client.ts'

export interface AuthStatus {
  enabled: boolean
  bootstrap: boolean
  mode: string
  account_base_url?: string
  methods?: string[]
}

export interface AuthUser {
  user_id: string
  email: string
  auth: boolean
  display_name?: string
  nickname?: string
}

export async function getAuthStatus(): Promise<AuthStatus | null> {
  return getJson<AuthStatus>('/api/auth/status')
}

export async function getAuthMe(): Promise<AuthUser | null> {
  return getJson<AuthUser>('/api/auth/me')
}

export async function postAuthLogout(): Promise<unknown> {
  return postJson('/api/auth/logout', {})
}

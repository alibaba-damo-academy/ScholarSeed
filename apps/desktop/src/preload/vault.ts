import { contextBridge, ipcRenderer } from 'electron'
import { VAULT_CHANNEL, VAULT_ERROR, parseVaultCancel, parseVaultReset, parseVaultSubmit, type VaultReply, type VaultViewBridge } from '../vault.ts'

const invalid: VaultReply = { ok: false, error: VAULT_ERROR.invalidInput }
const bridge: VaultViewBridge = Object.freeze({
  seed: () => ipcRenderer.invoke(VAULT_CHANNEL.seed),
  submit: (value: Parameters<VaultViewBridge['submit']>[0]) => { const parsed = parseVaultSubmit(value); return parsed ? ipcRenderer.invoke(VAULT_CHANNEL.submit, parsed) : Promise.resolve(invalid) },
  cancel: (value: Parameters<VaultViewBridge['cancel']>[0]) => { const parsed = parseVaultCancel(value); return parsed ? ipcRenderer.invoke(VAULT_CHANNEL.cancel, parsed) : Promise.resolve(invalid) },
  confirmReset: (value: Parameters<VaultViewBridge['confirmReset']>[0]) => { const parsed = parseVaultReset(value); return parsed ? ipcRenderer.invoke(VAULT_CHANNEL.reset, parsed) : Promise.resolve(invalid) }
})
contextBridge.exposeInMainWorld('vault', bridge)

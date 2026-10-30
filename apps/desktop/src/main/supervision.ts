import { BackendControl } from './backend-control.ts'

export class DevelopmentSupervisor extends BackendControl {
  async exit(generation: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(generation))
      throw new Error('invalid development maintenance generation')
    const response = await this.request({ operation: 'exit', generation })
    const valid = response.length === 1
    response.fill(0)
    if (!valid) {
      this.close()
      throw new Error('private development exit invalid')
    }
  }
}

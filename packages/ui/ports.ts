import { cardPorts, type CardRequest, type LiteratureCardPorts } from '../../apps/desktop/src/renderer/src/features/literature/ports'

export function createLiteraturePorts(
  request: (action: string, values: Record<string, unknown>) => Promise<unknown>,
  scope: { projectId?: string; projectName?: string } = {},
): LiteratureCardPorts {
  const typed: CardRequest = async <Result,>(action: string, values: Record<string, unknown> = {}) =>
    await request(action, values) as Result
  return cardPorts(typed, scope)
}

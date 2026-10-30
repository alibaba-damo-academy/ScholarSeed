type Check = () => Promise<number>
type Stop = () => Promise<void>
type Exit = (code: number) => void

export async function finishHeadlessCheck(check: Check, stop: Stop, exit: Exit): Promise<void> {
  let code = 1
  try {
    code = await check()
  } finally {
    await stop()
    exit(code)
  }
}

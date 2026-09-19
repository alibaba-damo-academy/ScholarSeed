type Check = () => Promise<number>
type Stop = () => void
type Exit = (code: number) => void

export async function finishHeadlessCheck(
  check: Check,
  stop: Stop,
  exit: Exit
): Promise<void> {
  let code = 1
  try {
    code = await check()
  } finally {
    stop()
    exit(code)
  }
}

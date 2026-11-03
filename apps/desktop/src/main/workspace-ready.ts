import type { WebContents } from 'electron'

/** A loaded document alone is not a usable workspace. No user content is collected. */
export const WORKSPACE_READY_SCRIPT = `(() => {
  const ready = () => {
    const body = document.querySelector('.vds-workspace-body');
    const loading = Boolean(document.querySelector('[data-testid="progress-screen"]'));
    const failed = Boolean(document.querySelector('[data-i18n-title="shell:errorBoundary.notice"]'));
    const controls = Boolean(body?.querySelector('[data-testid="activity-home"], [data-testid="sidebar-new-chat"], [data-testid="sidebar-expand"]'));
    return document.readyState === 'complete' && Boolean(body) && controls && !loading && !failed;
  };
  if (!ready()) return false;
  // Main-process timers and DOM hydration do not imply a new compositor frame.
  return new Promise(resolve => {
    let first = 0, second = 0;
    const timeout = setTimeout(() => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      resolve(false);
    }, 1000);
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve(ready());
      });
    });
  });
})()`

export async function workspaceReady(
  contents: Pick<WebContents, 'executeJavaScript'>
): Promise<boolean> {
  return contents.executeJavaScript(WORKSPACE_READY_SCRIPT).then(
    (value) => value === true,
    () => false
  )
}

/** Require consecutive samples so an initial shell or a navigation transition cannot pass. */
export async function waitForWorkspaceReady(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
  now = Date.now,
  sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<boolean> {
  const deadline = now() + timeoutMs
  let previous = false
  while (now() < deadline) {
    const ready = await probe().catch(() => false)
    if (ready && previous) return true
    previous = ready
    await sleep(intervalMs)
  }
  return false
}

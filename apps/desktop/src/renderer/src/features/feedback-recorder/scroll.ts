interface StepListScrollContainer {
  scrollHeight: number;
  scrollTop: number;
}

export function scrollStepListToLatest(
  container: StepListScrollContainer | null,
  expanded: boolean,
): void {
  if (!container || !expanded) return;
  container.scrollTop = container.scrollHeight;
}

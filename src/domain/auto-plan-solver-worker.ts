import { solveAutoPlanInProcess } from "./auto-plan-solver.js";

declare const self: Worker;

self.onmessage = async (
  event: MessageEvent<{
    input: Parameters<typeof solveAutoPlanInProcess>[0];
    deadlineMs: number;
  }>,
) => {
  try {
    self.postMessage(
      await solveAutoPlanInProcess(event.data.input, event.data.deadlineMs),
    );
  } catch {
    self.postMessage({
      status: "time_limited",
      selectedIds: [],
      objective: 0,
    });
  }
};

import { finishRun } from "./lib.js";

/** How often a following command looks for new commits. GNU `tail -f` sleeps one second between checks by default. */
export const FOLLOW_POLL_INTERVAL_MS = 1_000;

const INTERRUPT_SIGNAL = "SIGINT";
const CLOSED_PIPE_CODE = "EPIPE";

/**
 * Calls poll every interval until the command is stopped.
 * Resolves when the reader of stdout has closed it, which a write reports.
 * Rejects with what poll throws, which is how poll ends the command.
 * An interrupt ends the process by its signal, as it ends a command that handles no signal.
 */
export function followUntilStopped(poll: (signal: AbortSignal) => void | Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    const stopped = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    function stopPolling() {
      clearTimeout(timer);
      stopped.abort();
      process.off(INTERRUPT_SIGNAL, interrupt);
    }

    async function pollOnce() {
      try {
        await poll(stopped.signal);
      } catch (error) {
        if (!stopped.signal.aborted) {
          stopPolling();
          reject(error);
        }
        return;
      }

      if (!stopped.signal.aborted) {
        timer = setTimeout(pollOnce, FOLLOW_POLL_INTERVAL_MS);
      }
    }

    function interrupt() {
      stopPolling();
      finishRun();
      // The listener is gone, so the signal now ends the process and the shell sees an interrupt.
      process.kill(process.pid, INTERRUPT_SIGNAL);
    }

    process.once(INTERRUPT_SIGNAL, interrupt);

    // Stays attached, so a write already on its way to the closed pipe cannot crash the process.
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (stopped.signal.aborted) {
        return;
      }
      stopPolling();

      if (error.code === CLOSED_PIPE_CODE) {
        resolve();
      } else {
        reject(error);
      }
    });

    timer = setTimeout(pollOnce, FOLLOW_POLL_INTERVAL_MS);
  });
}

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
export function followUntilStopped(poll: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        poll();
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, FOLLOW_POLL_INTERVAL_MS);

    process.once(INTERRUPT_SIGNAL, () => {
      clearInterval(timer);
      finishRun();
      // The listener is gone, so the signal now ends the process and the shell sees an interrupt.
      process.kill(process.pid, INTERRUPT_SIGNAL);
    });

    // Stays attached, so a write already on its way to the closed pipe cannot crash the process.
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
      clearInterval(timer);

      if (error.code === CLOSED_PIPE_CODE) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

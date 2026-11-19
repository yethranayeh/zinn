export type BoardRefresh = {
  refresh: () => Promise<void>;
  arm: () => void;
  stop: () => void;
};

export type BoardRefreshInput = {
  summary: () => boolean;
  directory: () => string;
  routed: () => boolean;
  seconds: () => number;
  read: () => Promise<void>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

/** Schedules board reads only while a session is routed and the summary is shown. */
export const createBoardRefresh = (input: BoardRefreshInput): BoardRefresh => {
  let timer: ReturnType<typeof setInterval> | undefined;
  const set = input.setInterval ?? setInterval;
  const clear = input.clearInterval ?? clearInterval;
  const active = () => input.summary() && input.directory() !== "" && input.routed();

  const refresh = async () => {
    if (!active()) {
      return;
    }
    await input.read();
  };

  const stop = () => {
    if (timer !== undefined) {
      clear(timer);
    }
    timer = undefined;
  };

  const arm = () => {
    stop();
    if (!active()) {
      return;
    }
    timer = set(() => void refresh(), input.seconds() * 1_000);
  };

  return { refresh, arm, stop };
};

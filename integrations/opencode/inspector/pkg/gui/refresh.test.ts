import { expect, test } from "bun:test";

import { createBoardRefresh } from "./refresh.ts";

const noop = () => {};

const timer = () => 1 as unknown as ReturnType<typeof setInterval>;

test("an empty session arms no timer and makes no read", async () => {
  let reads = 0;
  let armed = 0;
  const board = createBoardRefresh({
    summary: () => true,
    directory: () => "",
    routed: () => false,
    seconds: () => 60,
    read: async () => {
      reads += 1;
    },
    setInterval: () => {
      armed += 1;
      return timer();
    },
    clearInterval: noop,
  });

  board.arm();
  await board.refresh();

  expect(reads).toBe(0);
  expect(armed).toBe(0);
  board.stop();
});

test("a routed session reads once and arms the interval", async () => {
  let reads = 0;
  let armed = 0;
  const board = createBoardRefresh({
    summary: () => true,
    directory: () => "/work",
    routed: () => true,
    seconds: () => 60,
    read: async () => {
      reads += 1;
    },
    setInterval: () => {
      armed += 1;
      return timer();
    },
    clearInterval: noop,
  });

  await board.refresh();
  board.arm();

  expect(reads).toBe(1);
  expect(armed).toBe(1);
  board.stop();
});

test("a hidden summary arms no timer and makes no read", async () => {
  let reads = 0;
  let armed = 0;
  const board = createBoardRefresh({
    summary: () => false,
    directory: () => "/work",
    routed: () => true,
    seconds: () => 60,
    read: async () => {
      reads += 1;
    },
    setInterval: () => {
      armed += 1;
      return timer();
    },
    clearInterval: noop,
  });

  board.arm();
  await board.refresh();

  expect(reads).toBe(0);
  expect(armed).toBe(0);
  board.stop();
});

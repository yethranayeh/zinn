import { Command, Ipc, Plugin } from "@opencode/plugin/gui";
import { Schema } from "effect";

const Ping = Ipc.define({
  id: "zinn.ping",
  methods: {
    ping: { output: Schema.String },
  },
});

export default Plugin.define({
  setup(ctx) {
    ctx.add(Command, {
      id: "ping",
      title: "Zinn: ping the desktop bridge",
      description: "Check that the Zinn desktop entry can call its main process.",
      group: "Zinn",
      run: () => {
        void (async () => {
          try {
            const result = await ctx.main(Ping).ping();
            ctx.toast.show({ title: `${ctx.id}: ${result}` });
          } catch (error) {
            ctx.toast.show({ title: `${ctx.id}: ${String(error)}`, variant: "error" });
          }
        })();
      },
    });
  },
  main(ctx) {
    ctx.provide(Ping, { ping: () => "pong" });
  },
});

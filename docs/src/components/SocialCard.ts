import { jsx } from "satori/jsx/jsx-runtime";

const colors = {
  limestone: "#e8e0cc",
  bone: "#d6cbb0",
  bronze: "#c8963c",
  cinnabar: "#7b1e15",
  soot: "#1c1815",
};

export function SocialCard({ command }: { command: string }) {
  return jsx("div", {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      position: "relative",
      backgroundColor: colors.limestone,
      color: colors.soot,
      fontFamily: "Alan Sans",
    },
    children: [
      jsx("div", {
        style: {
          display: "flex",
          position: "absolute",
          left: 68,
          top: 62,
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: -2,
        },
        children: [
          jsx("span", { children: "Z" }),
          jsx("span", { style: { color: colors.cinnabar }, children: "I" }),
          jsx("span", { children: "NN" }),
        ],
      }),
      jsx("div", {
        style: { position: "absolute", left: 68, top: 178, fontSize: 70 },
        children: "A kanban workflow",
      }),
      jsx("div", {
        style: { display: "flex", position: "absolute", left: 68, top: 257, fontSize: 70 },
        children: [
          jsx("span", { style: { whiteSpace: "pre" }, children: "in the " }),
          jsx("span", { style: { color: colors.cinnabar }, children: "terminal." }),
        ],
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 68,
          top: 387,
          width: 1064,
          height: 121,
          backgroundColor: colors.soot,
        },
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 96,
          top: 407,
          fontFamily: "MonoMMM",
          fontSize: 26,
          color: colors.bronze,
        },
        children: "$",
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 143,
          top: 407,
          fontFamily: "MonoMMM",
          fontSize: 26,
          color: colors.limestone,
        },
        children: command,
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 143,
          top: 450,
          fontFamily: "MonoMMM",
          fontSize: 26,
          color: colors.bone,
        },
        children: "zinn --help",
      }),
      jsx("div", {
        style: { position: "absolute", left: 68, top: 555, fontFamily: "MonoMMM", fontSize: 18 },
        children: "zinn.sh",
      }),
    ],
  });
}

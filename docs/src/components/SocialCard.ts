import { jsx } from "satori/jsx/jsx-runtime";

const colors = {
  limestone: "#e8e0cc",
  bone: "#d6cbb0",
  bronze: "#c8963c",
  cinnabar: "#7b1e15",
  soot: "#1c1815",
  pewter: "#6e675c",
};

const changelogCovers = ["CLI", "Core", "Integrations"];

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

export function ChangelogCard({ wordmark }: { wordmark: string }) {
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
      jsx("img", {
        src: wordmark,
        width: 240,
        height: 77,
        style: { position: "absolute", left: 68, top: 54 },
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 340,
          top: 54,
          width: 1,
          height: 512,
          backgroundColor: colors.pewter,
        },
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 68,
          top: 200,
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: 2.6,
          color: colors.pewter,
        },
        children: "COVERS",
      }),
      ...changelogCovers.map((name, index) => {
        const top = 240 + index * 64;

        return jsx("div", {
          style: {
            position: "absolute",
            left: 68,
            top,
            width: 200,
            display: "flex",
            flexDirection: "column",
          },
          children: [
            jsx("div", {
              style: { fontSize: 30, fontWeight: 600, letterSpacing: -0.5 },
              children: name,
            }),
            index < changelogCovers.length - 1
              ? jsx("div", {
                  style: {
                    position: "absolute",
                    top: 48,
                    left: 0,
                    width: 200,
                    height: 1,
                    backgroundColor: colors.pewter,
                  },
                })
              : null,
          ],
        });
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 404,
          top: 118,
          width: 728,
          fontSize: 124,
          fontWeight: 600,
          letterSpacing: -6,
          lineHeight: 1,
        },
        children: "CHANGELOG",
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 406,
          top: 284,
          width: 72,
          height: 4,
          backgroundColor: colors.cinnabar,
        },
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 404,
          top: 320,
          width: 700,
          fontSize: 30,
          lineHeight: 1.35,
          color: colors.pewter,
        },
        children: "Notable changes to the CLI, core and integrations.",
      }),
      jsx("div", {
        style: {
          position: "absolute",
          left: 404,
          top: 560,
          fontFamily: "MonoMMM",
          fontSize: 18,
          color: colors.pewter,
        },
        children: "zinn.sh/changelog",
      }),
    ],
  });
}

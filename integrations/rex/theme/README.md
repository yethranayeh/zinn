# Zinn theme for Rex

A theme for the Rex terminal in dark and light.

## Install

The files are `zinn-dark` and `zinn-light`, both in this directory.

Import each one with the Rex CLI:

```sh
rex -C "My Mac" do client.theme.import path=/Users/you/Downloads/zinn-dark
rex -C "My Mac" do client.theme.import path=/Users/you/Downloads/zinn-light
```

Replace `My Mac` with the client label that `rex client ls` shows, and each path with the full path where you saved the file.

There is no Lua here. `client.theme.import` is the app's Import Theme File action and `path` is its only argument. The imported theme takes its name from the file name and applies immediately. Import both files to fill the dark and light sides of the theme pair.

Each file sets the 16 ANSI colors. Rex fills the rest of the 256-color palette with xterm's standard colors.

## Compatibility

Verified with Rex Beta 0.1.0 (1696) on macOS. Rex accepts Ghostty themes, so they are in that particular format, so they technically also work in Ghostty too:

```sh
mkdir -p ~/.config/ghostty/themes
cp zinn-dark zinn-light ~/.config/ghostty/themes/
```

Then set `theme = light:zinn-light,dark:zinn-dark` in the Ghostty config.

## Palette

| ink       | hex       |
| --------- | --------- |
| limestone | `#E8E0CC` |
| bone      | `#D6CBB0` |
| clay      | `#B4552F` |
| cinnabar  | `#7B1E15` |
| bronze    | `#C8963C` |
| soot      | `#1C1815` |
| pewter    | `#6E675C` |

Zinn has no green, blue or magenta ink. The theme uses a shade of green borrowed from the [Zinn theme for OpenCode](https://zinn.sh/integrations/opencode/theme), patina for blue and cyan, and murex for magenta.

## Editing

`zinn-dark` and `zinn-light` are the canonical themes. Every value is a plain hex color. Keep both files to the same key set. After an edit, import the theme again to review the change in Rex.

# Zinn theme for the OpenCode TUI

A theme for OpenCode's CLI client.

## Install

```sh
mkdir -p ~/.config/opencode/themes
cp zinn.json ~/.config/opencode/themes/zinn.json
```

Select it in the running TUI with `/themes`, or set it in `~/.config/opencode/cli.json`:

```json
{ "theme": { "name": "zinn", "mode": "system" } }
```

`mode` is `system`, `dark` or `light`. OpenCode uses the file name as the theme name, so keep it `zinn.json`.

## Compatibility

The theme targets OpenCode v2 and is resolved by the host's own theme parser. It was verified on OpenCode **2.1.4**. The host's token schema can gain roles between releases, so check both modes after a host upgrade.

The theme is a file, not a package. There is no registry and no plugin hook that registers a theme.

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

The theme derives its ramps from those values. It also borrows the host's syntax and diff colours, because Zinn has no green ink.

## Editing

`zinn.json` is the canonical theme. Every colour is either a hex value or a `$` reference into the same document, so a change is a data edit. After an edit, load the theme in both modes and confirm that every reference still resolves.

# Zinn theme for Firefox

The Zinn color palette for Firefox, with light and dark appearances, in two textures: Lattice and Halftone.

## Build

```sh
bun run firefox:build
```

`theme/theme.json` holds the palette and the texture definitions. The build writes `dist/zinn-lattice/` and `dist/zinn-halftone/`, each with its manifest and frame images, and zips each into an `.xpi` for AMO.

## Install

Load a built theme as a temporary add-on:

1. Run the build.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select `dist/zinn-lattice/manifest.json` or `dist/zinn-halftone/manifest.json`.
4. Open `about:addons`, open Themes, and select **Zinn Lattice** or **Zinn Halftone**.

Firefox removes a temporary add-on when it restarts.

## Compatibility

The themes target Firefox 157 and later, the Nova interface introduced in that release.

A Firefox theme sets chrome colors and header images only. It cannot change shapes, radii, fonts or page content, and the accent color used for buttons and menu highlights comes from Firefox.

## Palette

| ink       | hex       |
| --------- | --------- |
| soot      | `#1C1815` |
| limestone | `#E8E0CC` |
| bronze    | `#C8963C` |
| cinnabar  | `#7B1E15` |

Surfaces between soot and limestone come from the neutral and surface ramps in the [Zinn theme for OpenCode](https://zinn.sh/integrations/opencode/theme). Dark uses bronze for the selected tab line and attention icons. Light uses cinnabar, which stays legible on limestone where bronze does not.

## Textures

**Lattice** is an even 6 px dot grid.

**Halftone** is a staggered 4 px grid whose dots grow toward the top edge over 96 px. It is tiled horizontally, so one image covers any window width without stretching.

Both sit in the top toolbars and leave the sidebar on the frame color.

## Editing

`theme/theme.json` is canonical. `colors.light` and `colors.dark` keep the same keys, and each texture names its frame images. Edit data, not code, then run the build again and reload the add-on.

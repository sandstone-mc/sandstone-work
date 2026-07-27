---
name: schematic-format-layout
description: "WorldEdit/MCEdit .schem file structure — Offset vs WorldEdit.Origin, two parsing formats, varint BlockData"
metadata: 
  node_type: memory
  type: reference
  originSessionId: cbfd4b86-22f0-4328-866d-536130fc65c2
---

# `.schem` file layout (WorldEdit/MCEdit)

The project's `sandstone_booth.schem` uses a hybrid MCEdit-wrapped variant. Sponge schematics have a different layout — `scripts/extract-blocks.ts` detects both.

## Structure (hybrid MCEdit variant)

Gzipped NBT, root compound:
```
Schematic: {
  Width: short
  Height: short
  Length: short
  Offset: int[3]          // paste anchor — where local (0,0,0) → world
  Version: int
  DataVersion: int
  Metadata: {
    Date: int[2]
    WorldEdit: {
      Version: string
      EditingPlatform: string
      Origin: int[3]      // absolute player position at //copy -e time
      Platforms: { ... }
    }
  }
  Blocks: compound {       // NOT a byte array — wraps the Sponge-style data
    Palette: compound<string, int>      // block-state string → palette index
    Data: byteArray                      // varint-encoded palette indices
    BlockEntities: list<compound>        // tile entities (signs, banners, etc.)
  }
  Entities: list<compound>
}
```

## Sponge variant (not this file)

Top-level `Palette`, `BlockData`, `Metadata`, `Offset`, `Width`, `Height`, `Length`. Same varint-encoded `BlockData`.

## Two distinct world-position fields

- **`Offset`** (cuboid bottom corner relative to `WorldEdit.Origin`): `int[3]`. The cuboid's WENW (lowest-x, lowest-y, lowest-z) corner's offset from `WorldEdit.Origin`. So the cuboid corner in world = `Origin + Offset`. All block positions in the schematic are relative to this cuboid corner.
- **`Metadata.WorldEdit.Origin`** (modern WE `//copy -e` anchor): `int[3]`. Absolute world position the player was at when `//copy -e` was run. Use this as the "teleport here" reference, then apply the per-block deltas to land on each block.

Both are absolute world coords / absolute offsets — the cuboid's world-space corner is computed as `Origin + Offset`, and each block's world position is `Origin + Offset + local`.

For `sandstone_booth.schem`: `Offset = (5, -26, -61)`, `WorldEdit.Origin = (-104, 83, 81)`. Cuboid corner world = `(-99, 57, 20)`. The Offset and Origin *can* disagree if the schematic was paste-and-resaved.

## Block iteration

`Data` byte array = varint sequence of palette indices, one per block. Block order is `(y * Length + z) * Width + x` (y slowest, x fastest). To extract:
- `x = i % Width`
- `z = (i / Width) % Length`
- `y = i / (Width * Length)`

Common bug: using `Height` in the z or y denominator (should be `Length`).

## Palette key format

`"minecraft:black_wall_banner[facing=south]"` — block ID + `[k=v,k=v]` properties. Some properties are bool (`open=true`) or int (`power=5`), most are strings.

## Why prismarine-schematic didn't work

Installed `prismarine-schematic` v1.3.0 expects `prismarine-nbt`'s `simplify()` to unwrap primitives, but the installed `prismarine-nbt` version doesn't — primitives stay as `{type, value}`. The lib reads garbage. Wrote a direct NBT reader in `scripts/extract-blocks.ts` instead.
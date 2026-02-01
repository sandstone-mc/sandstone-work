## Supplemental docs for [minecraft.wiki/w/Commands/test](https://minecraft.wiki/w/Commands/test)

- Test selector (`minecraft:resource_selector[test_instance]`): \
  Selects multiple tests given a mojank glob pattern.
  - `*` - matches from 0 to any number of alphanumeric characters.
  - `?` - matches exactly one alphanumeric character.

  Official examples:
    - `*:*` - matches all IDs.
    - `*` - matches everything in the minecraft namespace.
    - `custom:foo/*_test_?` - matches IDs in the `foo` subfolder in the `custom` namespace \
    that end in `_test_` followed by one additional character (probably a number).
- Until Failed (`<untilFail: boolean>`): \
  If `repeat` is specified, each individual test in the run will stop repeating if they fail once.
- Rotation (`<rotation: int @ 0..3>`): \
  Each test in the run (and every repetition) will be rotated by a static 0, 90, 180, or 270 degrees. (Use `verify` if you need lots of repetition at all cardinal directions)
- "Reset" (`resetclosest`, `resetthat`, `resetthese`): \
  Resets the state of the test(s) and their structure(s).
- "Closest" (`resetclosest`, `runclosest`): \
  Selects the closest test instance block (execution position).
- "That" (`resetthat`, `runthat`, etc.): \
  Selects the test instance block by the structure bounding box that is being targeted (execution position and rotation).
- "These" (`resetthese`, `runthese`, etc.): \
  Selects all test instance blocks within 250 blocks (execution position).
- ```mcfunction
  test verify <tests: minecraft:resource_selector[test_instance]>
  ```
  Verify (run) all of the selected tests 400 times each; 100 iterations per cardinal direction.
- ```mcfunction
  test runfailed
  test runfailed <repeat: int @ 1..> [<untilFail: boolean>] [<rotation: int @ 0..3>] [<gridLength: int @ 1..>]
  test runfailed <onlyRequired: true> [<repeat>]
  ```
  Re-runs all of the tests that failed in the last run.

  When starting any test run (whether its multiple tests or a single test, including when using this method),
  the internal list of failed tests is reset. After the test run completes or is stopped, all failed tests are added to the list.

  If `onlyRequired` is specified, only the failed tests that have [`TestData#required`](https://github.com/SpyglassMC/vanilla-mcdoc/blob/0639fe6f1cff1973b6c414eb82a8393a7268d448/java/data/gametest/mod.mcdoc#L30-L31) set to `true` will be re-ran.
- ```mcfunction
  test pos <javaVariableName>
  ```
  If the targeted block is inside the bounding box of a test, highlights the targeted block with a debug overlay of its coordinates relative to the test instance block^[source needed] using [`ClientboundGameTestHighlightPosPacket`](https://mcsrc.dev/#1/26.1-snapshot-5/net/minecraft/gametest/framework/TestCommand#L557). \
  Command output:
  ```jsonc
  {
    "type": "translatable",
    "translate": "minecraft:commands.test.relative_position",
    "with": [
      "ns:foo", // test id from the test instance block
      {
        "type": "translatable",
        "translate": "minecraft:commands.test.coordinates",
        "with": [
          "rx", // Coordinates of the targeted block relative to the test instance block
          "ry",
          "rz"
        ],
        "color": "green",
        "bold": true,
        "click_event": { // Java code with the coordinates of the targeted block relative to the test instance block
          "action": "copy_to_clipboard", 
          "value": "final BlockPos javaVariableName = new BlockPos(rx, ry, rz);" 
        },
        "hover_event": {
          "action": "show_text",
          "value": {
            "type": "translatable",
            "translate": "commands.test.coordinates.copy"
          }
        }
      }
    ]
  }
  ```
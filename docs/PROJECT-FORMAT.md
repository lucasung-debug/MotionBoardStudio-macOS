# Project JSON format

Version 1 stores an editable motion board as a UTF-8 JSON object. Save it with a `.json` extension and open it through the app's Open action. The native file picker accepts files up to 1,048,576 bytes. Validation runs when a project is decoded or encoded.

## Example

```json
{
  "schemaVersion": 1,
  "title": "Motion Study",
  "duration": 8,
  "fps": 30,
  "aspectRatio": "landscape",
  "tiles": [
    {
      "id": "6D237508-1A89-4A87-8D86-CA976B3941AE",
      "title": "Reveal",
      "detail": "A shape appears through a moving edge.",
      "effect": "reveal",
      "accent": "#2F6553"
    }
  ]
}
```

## Board fields

All fields are required.

| Field | Type | Accepted value |
| --- | --- | --- |
| `schemaVersion` | Integer | `1`; other versions are rejected |
| `title` | String | 1–120 characters; must contain more than whitespace |
| `duration` | Number | Finite value from 2 through 30, in seconds |
| `fps` | Integer | `24`, `30`, or `60` |
| `aspectRatio` | String | `landscape`, `square`, or `portrait` |
| `tiles` | Array | 1–16 tile objects; array order determines board order |

Aspect ratios are 16:9, 1:1, and 9:16 respectively. Export dimensions are rounded to even pixels for video encoding.

## Tile fields

All fields are required, including `detail`, which may be an empty string.

| Field | Type | Accepted value |
| --- | --- | --- |
| `id` | String | Hyphenated UUID, unique within the project |
| `title` | String | 1–60 characters; must contain more than whitespace |
| `detail` | String | Up to 500 characters |
| `effect` | String | One of the identifiers below, with exact lowercase spelling |
| `accent` | String | `#RRGGBB`; uppercase and lowercase hexadecimal digits are accepted |

Supported effects: `reveal`, `morph`, `orbit`, `bars`, `wave`, `rings`, `stagger`, `counter`, `spotlight`, `marquee`, `draw`, `stack`, `split`, `bounce`, `grid`, and `pulse`.

Keep a tile's UUID when editing it. The renderer derives a stable phase offset from that identifier, so changing it can change the tile's pose at the same timeline position. Duplicate UUIDs are rejected regardless of letter case.

## Text, timing, and persistence

The native model counts Swift characters rather than UTF-8 bytes. JSON save/open preserves authored text; the renderer collapses whitespace for display and may truncate text to fit the board. Text fields supply board and tile labels, not executable code or custom effect definitions.

Every tile shares the board's duration. Playback wraps at the loop boundary. Video frames sample `frameIndex / fps` while that time is less than `duration`; the endpoint is omitted to avoid duplicating the first pose at the seam. The MP4 session ends at the requested duration. A duration that is not a whole number of frames therefore has a shortened final frame instead of a longer loop.

Export resolution, motion blur, playback position, selection, and playback state are not part of the saved project. Four-sample motion blur is an MP4 export option. Version 1 has no audio, remote asset, provider, or credential fields.

The separate local recovery draft retains incomplete text edits. Exporting or saving a named project still requires the full valid document contract.

Only the documented fields form the version 1 contract. Unknown fields are not preserved on save. A different schema version, missing required field, invalid enum value, or failed validation prevents import. AI-generated JSON must meet the same rules as manually edited files.

The implementation lives in [MotionProject.swift](../Sources/MotionBoardCore/MotionProject.swift), [ProjectCodec.swift](../Sources/MotionBoardCore/ProjectCodec.swift), and [FrameSchedule.swift](../Sources/MotionBoardCore/FrameSchedule.swift).

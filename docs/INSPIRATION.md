# Inspiration and source boundaries

MotionBoardStudio is an original macOS project for arranging, editing, and exporting motion studies. Its implementation is being developed independently in this repository.

## Public reference

Charlie Hills's [public motion graphics article](https://charliehills.substack.com/p/opus-55-motion-graphics) presents 16 effects on a shared eight-second loop and a workflow using explicit states, references, and iteration. It describes an editable HTML result with fonts and images. The supporting guide and prompts require a free subscription; that material was not accessed for this project.

## Our implementation choices

The following choices belong to this project. They are not claims about the reference's source code or internal architecture:

- SwiftUI supplies native macOS editing controls; a WKWebView hosts an original Canvas renderer.
- Sixteen original effects share a playback clock and seekable timeline. Each tile has editable text, effect selection, and accent color.
- A local JSON document preserves the board for later editing.
- Standalone offline HTML, PNG stills, and native H.264 MP4 are implemented export formats. Rendering uses explicit frame timestamps, with cancellation for video export.

Implementation and acceptance status are tracked in [ROADMAP.md](ROADMAP.md); the completed checks and their limits are recorded in [VALIDATION.md](VALIDATION.md).

## Attribution and rights

The repository's MIT license covers its original source code. It does not grant rights to the linked article, its downloadable kit, or third-party text, fonts, images, audio, and other assets. Users retain their rights to their own assets and must have the permissions needed for anything they import or redistribute.

No source repository or reuse license was identified on the visible article page. Neither its gated prompts nor its kit has been copied into this project.

A recovered Windows application was used for an earlier architecture assessment. Permission to reuse its code is unresolved; its source and prompts are excluded from this implementation. This project is not presented as a licensed fork of that application.

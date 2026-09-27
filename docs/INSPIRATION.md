# Design reference and future improvements

The implementation baseline is the creator-provided MotionBoardStudio 0.3.2 application. Its production workflow is implemented locally through a Swift macOS host, WebKit, and a Node sidecar. The reference article informs later improvements; it does not replace the original workflow or define its source license.

## Public reference

Charlie Hills's [public motion graphics article](https://charliehills.substack.com/p/opus-55-motion-graphics) presents sixteen effects sharing an eight-second loop and a workflow using explicit states, references, and iteration. It describes an editable HTML result. The supporting guide and prompts require a free subscription; that material was not accessed for this project.

## Improvements to evaluate

| Reference idea | Proposed improvement | Status |
| --- | --- | --- |
| A shared loop | Expose a seekable scene preview before a full MP4 render | Planned |
| Explicit motion states | Add start, transition, and end-state fields to scene review | Planned |
| Iteration | Revise one scene while retaining approved scenes and assets | Planned |
| Editable HTML | Make the existing composition easier to preview and export alongside video | Planned |

These are project proposals, not claims about the article's source code. The current port already connects the original structured direction, motion code, frame review, and audio/video pipeline. Integration verification is ongoing; live providers and external-font fidelity remain unverified. The [roadmap](ROADMAP.md) separates that acceptance work from new features.

## Attribution

The original application's source is preserved in `upstream/MotionBoardStudio-0.3.2/`, with its original authors credited in [SOURCE-PROVENANCE.md](SOURCE-PROVENANCE.md). MIT publication follows the creator consent and direction supplied by the user. No original GitHub URL was supplied, and the source snapshot contains no standalone upstream license file.

The article and its downloadable kit are separate materials. Neither its gated prompts nor its kit has been copied. External fonts, music, imported images, and other assets retain their own terms.

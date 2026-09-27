# Design reference and proposed improvements

The implementation baseline is the creator-provided MotionBoardStudio 0.3.2 application. The reference article informs improvements to that workflow; it does not replace the original app with an unrelated tile editor.

## Public reference

Charlie Hills's [public motion graphics article](https://charliehills.substack.com/p/opus-55-motion-graphics) presents sixteen effects sharing an eight-second loop and a workflow using explicit states, references, and iteration. It describes an editable HTML result. The supporting guide and prompts require a free subscription; that material was not accessed for this project.

## Improvements to evaluate in the original app

| Observation | Proposed application improvement | Status |
| --- | --- | --- |
| Motion examples share a clear loop | Expose a shared seekable preview before committing to a full MP4 render | Planned |
| Explicit states help specify motion | Add start, transition, and end-state fields to scene review | Planned |
| Iteration is part of production | Revise one scene while retaining approved scenes and assets | Planned |
| Editable HTML can remain useful after generation | Provide a clearly labeled composition preview/export alongside video | Planned |

These are our design proposals, not assertions about the article's internal implementation. The original application already includes structured direction, generated motion code, review, and video rendering; the port should preserve those capabilities before expanding them.

## Source boundaries

The user clarified that the creator openly supplied the original application. Its recovered sources are now retained under `upstream/MotionBoardStudio-0.3.2/` as the porting baseline. [SOURCE-PROVENANCE.md](SOURCE-PROVENANCE.md) records this context and attribution.

The linked article and its downloadable kit are separate materials. Neither the gated prompts nor the kit has been copied. External fonts, music, and other assets retain their own terms.

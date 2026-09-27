# Source provenance

The user supplied the Windows distribution of MotionBoardStudio 0.3.2 and clarified that its creator openly provided the original code for use. The user directed this project to preserve and port that application to macOS and publish the work on GitHub under MIT. This origin statement is user-provided provenance; it is not an independently verified upstream release announcement.

## Preserved source

The [upstream/MotionBoardStudio-0.3.2](../upstream/MotionBoardStudio-0.3.2) directory contains the application's recovered source: Electron entry and bridge code, the original interface, provider modules, generation guides, storage, and the motion/audio/video pipeline.

On 2026-09-27, all 30 files in this snapshot matched the retained extraction byte for byte through SHA-256 comparison. Their combined size was 360,724 bytes. The snapshot is the porting reference; platform adaptations should remain distinguishable from these preserved files.

The packaged `package.json` identifies `motion-board-studio`, version `0.3.2`, with `main.cjs` as its entry point. It does not identify an author, repository URL, or license. The 30-file snapshot contains no standalone upstream license or notice file. No original repository URL was supplied, so this project is described as a source-based port rather than a GitHub network fork.

## Attribution and licensing record

The original application code, interface, and guide documents are attributed to the original MotionBoardStudio authors. Their names are not established by the recovered package metadata; this project does not invent an identity or attribute their work to the macOS port's contributors. Existing source content is preserved in the upstream snapshot.

MIT publication is the user's direction for this project. That direction must not be described as discovery of an upstream MIT license file. New macOS adaptation work and the preserved original application should remain identifiable in project history and documentation.

The public motion-graphics article discussed earlier is background context, not a verified download location or license source for this application. Fonts, music, imported images, and user assets retain their own applicable rights and attribution.

The separate Swift tile editor created earlier is a historical prototype, not the supplied application's source. Its results are not evidence that the original app has been fully ported. The active implementation scope and verification gaps are recorded in [ORIGINAL-PORT.md](ORIGINAL-PORT.md).

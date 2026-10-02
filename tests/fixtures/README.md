# Fixtures

## Media

`preview.mp4` is a generated 3-second blue frame (H.264/yuv420p), with no private or third-party content.
Reproduce with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=blue:s=160x90:d=3 -c:v libx264 -pix_fmt yuv420p -movflags +faststart preview.mp4
```

## noVNC

`novnc-ui-1.4.0.js` is `app/ui.js` from noVNC v1.4.0 (MPL 2.0, © The noVNC Authors), byte-identical to
`/opt/novnc/app/ui.js` in the pinned sandbox image. `tests/unit/novnc-patch.test.ts` checks the
phone-keyboard patch (`src/server/docker/novncPatch.ts`) against it. Source:
https://raw.githubusercontent.com/novnc/noVNC/v1.4.0/app/ui.js

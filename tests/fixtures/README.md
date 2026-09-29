# Media fixture

`preview.mp4` is a generated 3-second blue frame (H.264/yuv420p), with no private or third-party content.
Reproduce with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=blue:s=160x90:d=3 -c:v libx264 -pix_fmt yuv420p -movflags +faststart preview.mp4
```

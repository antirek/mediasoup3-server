#!/bin/sh

ffmpeg \
   -i left.mp4 \
   -i right.mp4 \
  -filter_complex " \
      [0:v] setpts=PTS-STARTPTS [a0]; \
      [1:v] setpts=PTS-STARTPTS,tpad=start_duration=7 [a1]; \
      [a0][a1]xstack=inputs=2:layout=0_0|w0_0[out] \
      " \
    -map "[out]" \
    -c:v libx264 -f matroska output_col_2x2.mp4


##   [0:v] setpts=PTS-STARTPTS [a0]; \

#!/usr/bin/env bash
# Writes short test clips to media/test/, each exercising a different path through the encoder. Every clip shows
# its own name and stream time, so you can tell what you're watching.
# Usage: scripts/make-test-media.sh [name ...]   (no names: all of them; DURATION seconds each, default 20)
set -euo pipefail
FFMPEG="${FFMPEG_PATH:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}"
DURATION="${DURATION:-20}"
cd "$(dirname "$0")/.."
mkdir -p media/test

label() {
  echo "drawtext=text='$1  %{pts\:hms}':fontsize=h/16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:x=24:y=h-th-24"
}

# pattern <size> <rate> <label>: sets VIDEO to the input arguments of a labelled test pattern.
pattern() {
  VIDEO=(-f lavfi -i "testsrc2=size=$1:rate=$2,$(label "$3")")
}

TONE=(-f lavfi -i "sine=frequency=440:sample_rate=48000")
H264=(-c:v libx264 -preset veryfast -pix_fmt yuv420p)
AAC=(-c:a aac -b:a 128k)

make() {
  local name="$1"
  shift
  echo "media/test/$name"
  "$FFMPEG" -hide_banner -loglevel error -y "$@" -t "$DURATION" "media/test/$name"
}

build() {
  case "$1" in
    720p30)           # rungs above the source are dropped: expect 720p and below
      pattern 1280x720 30 "720p30"; make 720p30.mp4 "${VIDEO[@]}" "${TONE[@]}" "${H264[@]}" "${AAC[@]}" ;;
    240p)             # smaller than every rung: expect one rendition at 240p
      pattern 426x240 30 "240p"; make 240p.mp4 "${VIDEO[@]}" "${TONE[@]}" "${H264[@]}" "${AAC[@]}" ;;
    no-audio)         # expect no audio in the master playlist's CODECS
      pattern 1920x1080 30 "no audio"; make no-audio.mp4 "${VIDEO[@]}" "${H264[@]}" ;;
    1080p60)          # expect 60 fps on 1080p/720p and 30 fps on the capped rungs
      pattern 1920x1080 60 "1080p60"; make 1080p60.mp4 "${VIDEO[@]}" "${TONE[@]}" "${H264[@]}" "${AAC[@]}" ;;
    1080i)            # 1080i29.97, top field first: expect progressive output at 29.97
      make 1080i.mp4 -f lavfi -i "testsrc2=size=1920x1080:rate=60000/1001,$(label "1080i"),tinterlace=interleave_top,fieldorder=tff" \
        "${TONE[@]}" "${H264[@]}" -flags +ildct+ilme -x264-params tff=1 "${AAC[@]}" ;;
    portrait)         # 1080x1920: expect 1080x1920, 720x1280, …
      pattern 1080x1920 30 "portrait"; make portrait.mp4 "${VIDEO[@]}" "${TONE[@]}" "${H264[@]}" "${AAC[@]}" ;;
    phone-rotated)    # stored 1920x1080 with a 90° rotation flag, like most phone video: expect portrait output
      pattern 1920x1080 30 "phone rotated"; make phone-rotated.tmp.mp4 "${VIDEO[@]}" "${TONE[@]}" "${H264[@]}" "${AAC[@]}"
      "$FFMPEG" -hide_banner -loglevel error -y -display_rotation:v:0 90 -i media/test/phone-rotated.tmp.mp4 -c copy media/test/phone-rotated.mp4
      rm media/test/phone-rotated.tmp.mp4
      echo "  (rotation flag applied)" ;;
    hevc)             # for passthrough: H.265 in MPEG-TS segments
      pattern 1920x1080 30 "HEVC"; make hevc.mp4 "${VIDEO[@]}" "${TONE[@]}" -c:v libx265 -preset fast -pix_fmt yuv420p -tag:v hvc1 \
        -x265-params log-level=error "${AAC[@]}" ;;
    hdr-hlg)          # 10-bit HEVC HLG, as phones record (reference white at 75%, BT.2408): expect SDR that looks like 720p30
      make hdr-hlg.mp4 -f lavfi -i "testsrc2=size=1920x1080:rate=30,$(label "HDR HLG"),zscale=tin=bt709:pin=bt709:min=bt709:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv:npl=203,format=yuv420p10le" \
        "${TONE[@]}" -c:v libx265 -preset fast -tag:v hvc1 \
        -x265-params log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc "${AAC[@]}" ;;
    surround)         # 5.1 audio: expect a stereo downmix
      pattern 1920x1080 30 "5.1 audio"; make surround.mp4 "${VIDEO[@]}" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
        "${H264[@]}" -af "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0" -c:a aac -b:a 384k ;;
    audio-gap)        # audio missing from 5s to 8s, as after dropped packets: expect silence there, still in sync
      pattern 1280x720 30 "audio gap 5-8s"; make audio-gap.ts "${VIDEO[@]}" "${TONE[@]}" "${H264[@]}" \
        -af "aselect='not(between(t,5,8))'" "${AAC[@]}" -f mpegts ;;
    *)
      echo "unknown clip: $1" >&2
      exit 1 ;;
  esac
}

ALL=(720p30 240p no-audio 1080p60 1080i portrait phone-rotated hevc hdr-hlg surround audio-gap)
for name in "${@:-${ALL[@]}}"; do build "$name"; done

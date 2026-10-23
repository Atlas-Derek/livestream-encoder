import { z } from 'zod';

export const RungSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/, 'rung name may only contain letters, digits, _ and -'),
  /** The picture's short side: the height of landscape video, the width of portrait video. */
  height: z.number().int().min(144).max(4320),
  videoBitrateKbps: z.number().int().positive(),
  audioBitrateKbps: z.number().int().positive(),
  /** Caps the frame rate by dropping every 2nd, 3rd… frame (60 -> 30, 50 -> 25); lower rungs gain little from 60. */
  maxFps: z.number().positive().max(240).optional(),
});
export type Rung = z.infer<typeof RungSchema>;

export const LadderSchema = z
  .array(RungSchema)
  .min(1)
  .refine((rungs) => new Set(rungs.map((r) => r.name)).size === rungs.length, 'rung names must be unique');

const FileInputSchema = z.object({
  type: z.literal('file'),
  /** Absolute, or relative to the repo root (e.g. media/sample.mp4). */
  path: z.string().min(1),
  loop: z.boolean().default(false),
});

const PullInputSchema = z.object({
  type: z.literal('pull'),
  url: z.url({ protocol: /^(rtsps?|rtmps?|https?|srt|udp)$/ }),
});

/**
 * Push sources can't be probed before a publisher connects, so whether they carry audio is declared up front.
 * It fixes the renditions in the master playlist, which must not change while players are watching.
 */
const pushAudio = z.boolean().default(true);

const RtmpInputSchema = z.object({
  type: z.literal('rtmp'),
  streamKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'stream key may only contain letters, digits, _ and -'),
  audio: pushAudio,
});

const SrtInputSchema = z.object({
  type: z.literal('srt'),
  /** SRT requires 10-79 characters when encryption is used. */
  passphrase: z.string().min(10).max(79).optional(),
  audio: pushAudio,
});

export const InputSchema = z.discriminatedUnion('type', [
  FileInputSchema,
  PullInputSchema,
  RtmpInputSchema,
  SrtInputSchema,
]);
export type Input = z.infer<typeof InputSchema>;

export const ChannelSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'id must be a lowercase slug (a-z, 0-9, _ and -)'),
    input: InputSchema,
    mode: z.enum(['live', 'vod']).default('live'),
    ladder: LadderSchema.optional(),
    segmentType: z.enum(['mpegts', 'fmp4']).default('mpegts'),
    passthrough: z.boolean().default(false),
    /** Burns each rendition's name into its picture, so ABR switches are visible in the player. For testing. */
    debugOverlay: z.boolean().default(false),
  })
  .superRefine((spec, ctx) => {
    if (spec.mode === 'vod' && !(spec.input.type === 'file' && !spec.input.loop)) {
      ctx.addIssue({ code: 'custom', path: ['mode'], message: 'vod mode requires a non-looping file input' });
    }
    if (spec.passthrough && spec.ladder) {
      ctx.addIssue({ code: 'custom', path: ['ladder'], message: 'passthrough produces a single rendition; omit ladder' });
    }
    if (spec.passthrough && spec.debugOverlay) {
      ctx.addIssue({ code: 'custom', path: ['debugOverlay'], message: 'passthrough does not re-encode, so it cannot draw an overlay' });
    }
  });
export type ChannelSpec = z.infer<typeof ChannelSpecSchema>;

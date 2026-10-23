import { createHash } from 'node:crypto';

/**
 * Signed playback URLs, checked by nginx's secure_link (nginx/nginx.conf): /hls/_s/<expires>/<token>/<channel>/…
 * The token goes in the path, not the query, because playlists list their variants and segments as relative URIs:
 * resolved against a signed playlist URL, they are signed too. It covers one channel (recordings included) until
 * <expires>, in Unix seconds.
 */
export const SIGNED_PREFIX = '_s';

/** secure_link_md5 "$secure_link_expires$hls_channel $hls_secret": base64url MD5, as nginx compares it. */
export function playbackToken(channel: string, expires: number, secret: string): string {
  return createHash('md5').update(`${expires}${channel} ${secret}`).digest('base64url');
}

/** Rounded up to the hour, so viewers who start around the same time share URLs, and caches with them. */
export function playbackExpiry(nowMs: number, ttlSeconds: number): number {
  return Math.ceil((nowMs / 1000 + ttlSeconds) / 3600) * 3600;
}

/** The URL a channel's files are under: signed when a secret is set, the plain /hls/<channel> otherwise. */
export function channelBaseUrl(baseUrl: string, channel: string, secret: string | null, expires: number): string {
  if (secret === null) return `${baseUrl}/${channel}`;
  return `${baseUrl}/${SIGNED_PREFIX}/${expires}/${playbackToken(channel, expires, secret)}/${channel}`;
}

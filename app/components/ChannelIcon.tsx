import { channelOf } from '@/lib/channels'

// The small rounded square with the channel's letter in white (22px by default).
export function ChannelIcon({ channel, size = 22 }: { channel: string | null | undefined; size?: number }) {
  const c = channelOf(channel)
  return (
    <span
      className="ch-icon"
      title={c.label}
      aria-label={c.label}
      style={{ background: c.color, width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      {c.letter}
    </span>
  )
}

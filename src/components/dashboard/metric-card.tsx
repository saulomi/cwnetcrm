import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

/**
 * Each metric gets its own hue instead of a flat muted-gray chip. Four
 * distinct accents so the row scans as four different signals, not one
 * repeated card shape — conversations (the app's core loop) stays on
 * brand primary, the other three each get a color already used
 * elsewhere in the product (quick actions, tag palette) so nothing new
 * is invented just for this row.
 */
const TINTS = {
  primary: "bg-primary-soft text-primary",
  growth: "bg-emerald-400/12 text-emerald-400",
  value: "bg-amber-400/12 text-amber-400",
  volume: "bg-violet-400/12 text-violet-400",
} as const

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /** Which accent this metric's icon chip takes. Defaults to primary. */
  tint?: keyof typeof TINTS
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({ title, value, icon: Icon, tint = "primary", delta, subtitle }: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", TINTS[tint])}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-[28px] leading-none font-bold tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-primary'
      : sign < 0
      ? 'text-red-400'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-2 flex items-center gap-1 text-sm', tone)}>
      <Arrow className="h-4 w-4" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}

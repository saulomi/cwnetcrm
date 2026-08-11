"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap, Plus } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'text-primary' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tint: 'text-blue-400' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tint: 'text-amber-400' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tint: 'text-primary' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')

  return (
    // Deliberately not a repeat of MetricCard's solid rounded-xl card:
    // these are shortcuts, not data, so they read as buttons — dashed
    // outline at rest, filled only on hover/focus — with a trailing
    // "+" that's true of every entry here (they all create something),
    // not decoration.
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3.5 py-2.5 transition-colors hover:border-solid hover:border-primary/40 hover:bg-primary-soft"
          >
            <Icon className={`h-4 w-4 shrink-0 ${a.tint}`} />
            <span className="flex-1 text-sm font-medium text-foreground">
              {t(a.labelKey as string)}
            </span>
            <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
          </Link>
        )
      })}
    </div>
  )
}

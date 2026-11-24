import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton for Inkludér / ekskludér: counts, then rules.
export default function Loading() {
  return <PageSkeleton blocks={[{ kind: 'stats', cells: 2 }, { kind: 'card', lines: 5 }]} />
}

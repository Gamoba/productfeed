import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton for the feed Overview: stats card, link and issue list.
export default function Loading() {
  return <PageSkeleton actions={2} blocks={[{ kind: 'stats', cells: 4 }, { kind: 'card', lines: 5 }]} />
}

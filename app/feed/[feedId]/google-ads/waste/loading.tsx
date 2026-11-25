import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton (Wasted spend: stats and a table), so a click shows the page's shape at once
// instead of waiting for the server. Without it the app root's skeleton (the
// agency dashboard) would stand in.
export default function Loading() {
  return <PageSkeleton actions={1} blocks={[{ kind: 'stats', cells: 3 }, { kind: 'table', rows: 8 }]} />
}

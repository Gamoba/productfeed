import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton (Monitoring: stats, quality table and issues), so a click shows the page's shape at once
// instead of waiting for the server. Without it the app root's skeleton (the
// agency dashboard) would stand in.
export default function Loading() {
  return <PageSkeleton actions={0} blocks={[{ kind: 'stats', cells: 4 }, { kind: 'table', rows: 8 }]} />
}

import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton (Shop feeds: one table grouped by market), so a click shows the page's shape at once
// instead of waiting for the server. Without it the app root's skeleton (the
// agency dashboard) would stand in.
export default function Loading() {
  return <PageSkeleton actions={2} blocks={[{ kind: 'table', rows: 8 }]} />
}

import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton (Labels: label tabs, buckets and the rule editor), so a click shows the page's shape at once
// instead of waiting for the server. Without it the app root's skeleton (the
// agency dashboard) would stand in.
export default function Loading() {
  return <PageSkeleton actions={1} blocks={[{ kind: 'card', lines: 3 }, { kind: 'card', lines: 7 }]} />
}

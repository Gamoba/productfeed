import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton (AI Titles bucket: steps and the workshop), so a click shows the page's shape at once
// instead of waiting for the server. Without it the app root's skeleton (the
// agency dashboard) would stand in.
export default function Loading() {
  return <PageSkeleton actions={1} blocks={[{ kind: 'card', lines: 3 }, { kind: 'card', lines: 7 }]} />
}

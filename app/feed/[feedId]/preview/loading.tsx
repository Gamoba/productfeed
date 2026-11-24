import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton for Preview & eksport: feed link, then the XML view.
export default function Loading() {
  return <PageSkeleton blocks={[{ kind: 'card', lines: 3 }, { kind: 'card', lines: 8 }]} />
}

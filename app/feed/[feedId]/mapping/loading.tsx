import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton for Mapping: field groups.
export default function Loading() {
  return <PageSkeleton blocks={[{ kind: 'toolbar' }, { kind: 'card', lines: 6 }, { kind: 'card', lines: 4 }]} />
}

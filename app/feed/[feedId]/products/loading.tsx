import { PageSkeleton } from '@/app/components/PageSkeleton'

// Route-level skeleton for Products: filters and the product table.
export default function Loading() {
  return <PageSkeleton blocks={[{ kind: 'toolbar' }, { kind: 'table', rows: 8 }]} />
}

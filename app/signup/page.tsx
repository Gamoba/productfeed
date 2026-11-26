import { SignupForm } from './SignupForm'

// Open signup for User accounts. ?ref=<code> comes from an MCC's referral link.
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ ref?: string | string[] }> }) {
  const { ref } = await searchParams
  return <SignupForm referral={typeof ref === 'string' ? ref : null} />
}

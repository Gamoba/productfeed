import { adminDb } from '@/lib/feeds'
import { planLinkInfo } from '@/lib/customPlans'
import { SignupForm } from './SignupForm'

// Open signup for User accounts.
//   ?ref=<code>   an agency's referral link (lib/signup.ts)
//   ?plan=<token> a custom plan's one-time link (lib/customPlans.ts)
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ ref?: string | string[]; plan?: string | string[] }> }) {
  const { ref, plan } = await searchParams
  const token = typeof plan === 'string' ? plan : null
  const offer = token ? await planLinkInfo(adminDb(), token) : null
  return (
    <SignupForm
      referral={typeof ref === 'string' ? ref : null}
      plan={offer && token ? { token, name: offer.planName, email: offer.email } : null}
      planLinkInvalid={!!token && !offer}
    />
  )
}

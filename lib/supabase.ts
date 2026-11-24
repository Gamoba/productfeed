import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Browser Supabase client, created on first use instead of at import.
//
// The app shell (UserMenu) imports this module, and the shell is in the root
// layout, so every page pulls it in, including pages Next.js prerenders at
// build time. Creating the client at import made the build fail wherever
// NEXT_PUBLIC_SUPABASE_URL isn't set at build time ("supabaseUrl is
// required"). Lazily, nothing runs until someone actually needs the client.
let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  return client
}

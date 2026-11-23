import type { Metadata } from 'next'
import { Outfit, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { AppShell } from './components/AppShell'

// UI font. Exposed as --font-outfit; globals.css builds --font on top of it.
const outfit = Outfit({
  variable: '--font-outfit',
  subsets: ['latin', 'latin-ext'],
  weight: ['300', '400', '500', '600'],
})

// Code font: XML/code blocks and API tokens only, never ordinary UI text.
const jetbrains = JetBrains_Mono({
  variable: '--font-jetbrains',
  subsets: ['latin'],
  weight: ['400', '500'],
})

export const metadata: Metadata = {
  title: 'FeedFlow',
  description: 'Google Shopping Feed Generator',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="da" className={`${outfit.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="h-full" suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}

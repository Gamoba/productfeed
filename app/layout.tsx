import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import { AppShell } from './components/AppShell'

// Fonts are self-hosted (app/fonts, SIL Open Font License): next/font/google
// downloaded them from Google on every build, and a slow or refused download
// failed the build. Both are variable fonts from github.com/google/fonts,
// trimmed to the Latin + Latin Extended ranges Google served (fontTools,
// WOFF2), so text renders exactly as before.

// UI font. Exposed as --font-outfit; globals.css builds --font on top of it.
const outfit = localFont({
  src: './fonts/Outfit-Variable.woff2',
  variable: '--font-outfit',
  weight: '100 900',
  display: 'swap',
})

// Code font: XML/code blocks and API tokens only, never ordinary UI text, so
// it isn't preloaded on every page.
const jetbrains = localFont({
  src: './fonts/JetBrainsMono-Variable.woff2',
  variable: '--font-jetbrains',
  weight: '100 800',
  display: 'swap',
  preload: false,
})

export const metadata: Metadata = {
  title: 'FeedFlow',
  description: 'Google Shopping Feed Generator',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="h-full" suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}

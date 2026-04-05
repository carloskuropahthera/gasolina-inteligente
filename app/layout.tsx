import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Gasolina Inteligente | Precios en Tiempo Real México',
  description: 'Encuentra la gasolina más barata cerca de ti. Datos oficiales CRE + precios verificados por la comunidad. Magna, Premium y Diésel en tiempo real para toda México.',
  keywords: ['gasolina barata', 'precios CRE', 'gasolineras México', 'ahorrar en gasolina', 'precios combustible Mexico', 'gasolina en tiempo real'],
  authors: [{ name: 'Gasolina Inteligente' }],
  openGraph: {
    title: 'Gasolina Inteligente — Precios en Tiempo Real México',
    description: 'Datos oficiales CRE + comunidad verificada. Encuentra la gasolina más barata cerca de ti.',
    type: 'website',
    locale: 'es_MX',
    siteName: 'Gasolina Inteligente',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Gasolina Inteligente — Precios en Tiempo Real',
    description: 'Encuentra la gasolina más barata en México. Datos CRE + comunidad.',
  },
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Gasolina',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  themeColor: '#09090f',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.svg" />
      </head>
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}

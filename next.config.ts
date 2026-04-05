import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Include data/ directory in serverless function trace for API route
  outputFileTracingIncludes: {
    '/api/stations': ['./data/**/*'],
  },
  // Allow Leaflet tile images
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.tile.openstreetmap.org' },
    ],
  },
};

export default nextConfig;

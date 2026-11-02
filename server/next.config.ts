import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pg', 'mqtt'],
  poweredByHeader: false,
};

export default config;

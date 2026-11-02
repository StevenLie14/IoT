import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',             // small self-contained server for Docker
  serverExternalPackages: ['pg', 'mqtt'],
  poweredByHeader: false,
};

export default config;

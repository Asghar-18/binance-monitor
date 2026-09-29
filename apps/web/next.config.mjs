import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker needs a standalone server; Vercel builds its own output.
  ...(process.env.BUILD_STANDALONE === '1' ? { output: 'standalone' } : {}),
  outputFileTracingRoot: join(here, '..', '..'),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;

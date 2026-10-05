import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // A self-contained server (.next/standalone) for the Docker image; traced from the monorepo root so the
  // workspace packages (@textagent/core, @textagent/cloud) are included.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  // PGlite ships WebAssembly; let Node load it instead of bundling it.
  serverExternalPackages: ['@electric-sql/pglite'],
};

export default config;

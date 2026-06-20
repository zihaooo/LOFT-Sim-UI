import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
  },
  build: {
    // Three.js dominates the bundle and is needed at startup, so there is no
    // useful lazy boundary. Split it into a stable vendor chunk for caching and
    // raise the warning limit, since the chunk legitimately exceeds 500 kB
    // uncompressed (~150-200 kB gzipped over the wire).
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          threeCSG: ["three-mesh-bvh", "three-bvh-csg"],
        },
      },
    },
  },
});

import { mergeConfig, defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Reuse the app's Vite config (React SWC + Tailwind) but run components in jsdom.
// `css: false` skips the Tailwind/PostCSS pipeline, which is hostile to jsdom.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      css: false,
      setupFiles: ["./test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
);

import { defineConfig } from "@neon/config/v1";

/**
 * Neon policy for easyWed.
 * Postgres only — invite images / WhatsApp auth stay on disk (DATA_DIR).
 */
export default defineConfig({
  auth: false,
  branch: (branch) => {
    if (branch.isDefault) {
      return {};
    }
    if (!branch.exists) {
      return { ttl: "7d" };
    }
    return {};
  },
});

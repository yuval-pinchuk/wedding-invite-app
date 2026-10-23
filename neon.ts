import { defineConfig } from "@neon/config/v1";

/**
 * Neon policy for easyWed.
 * Postgres holds accounts, RSVPs, payments, sessions, invite image bytes,
 * and WhatsApp auth files. DATA_DIR is a local cache only.
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

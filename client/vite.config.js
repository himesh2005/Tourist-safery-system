import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const API_TARGET = (env.VITE_API_URL || "http://localhost:5000").replace(
    /\/+$/,
    "",
  );

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/auth": {
          target: API_TARGET,
          changeOrigin: true,
        },
        "/api": {
          target: API_TARGET,
          changeOrigin: true,
        },
        "/me": {
          target: API_TARGET,
          changeOrigin: true,
        },
        "/my-card": {
          target: API_TARGET,
          changeOrigin: true,
        },
      },
    },
  };
});

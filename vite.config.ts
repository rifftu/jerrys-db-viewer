import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // src-tauri is watched by `tauri dev`; .claude holds agent worktrees whose edits would reload the app.
    watch: { ignored: ["**/src-tauri/**", "**/.claude/**"] },
  },
});

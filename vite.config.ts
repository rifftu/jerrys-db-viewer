import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // src-tauri is watched by `tauri dev`; .claude holds agent worktrees whose edits would reload the app.
    // Anchored to this root: a server running inside a worktree must still watch its own files.
    watch: { ignored: [`${root}src-tauri/**`, `${root}.claude/**`] },
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll('\\', '/');
          if (!path.includes('/node_modules/')) return;
          if (path.includes('/react/') || path.includes('/react-dom/')) return 'react-vendor';
          if (path.includes('/radix-ui/')) return 'radix-vendor';
          if (path.includes('/marked/') || path.includes('/sanitize-html/') || path.includes('/entities/')) return 'markdown-vendor';
        },
      },
      onwarn(warning, warn) {
        // lucide-react ships React Server Component directives; they are meaningless in this client bundle.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return;
        warn(warning);
      },
    },
  },
});

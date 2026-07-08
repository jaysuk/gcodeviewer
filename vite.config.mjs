import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { ensureWasmPkg, hasRealPkg } from './WASM_FileProcessor/ensure-pkg.mjs'

// Guarantee something is importable at WASM_FileProcessor/pkg/ before any plugin (notably
// vite-plugin-dts, which runs its own TS diagnostics ahead of wasmPackPlugin's buildStart) ever
// looks for it - otherwise a fresh clone without the Rust toolchain prints alarming but harmless
// "cannot find module" diagnostics even though the build itself succeeds.
ensureWasmPkg({ silent: true })

// Rebuilds the Rust WASM package when its sources are newer than the generated pkg output,
// so a plain `npm run build`/`npm run dev` never uses a stale or missing WASM module. When the
// Rust toolchain isn't installed, this falls back to the JS stub in pkg-fallback/ (see
// ensure-pkg.mjs) instead of failing the whole build - WASM parsing is simply unavailable and
// the TypeScript parser is used instead.
function wasmPackPlugin() {
  const crateDir = path.resolve(import.meta.dirname, 'WASM_FileProcessor')
  const pkgMarker = path.join(crateDir, 'pkg', 'gcode_file_processor.js')

  function newestSourceMtime(dir) {
    let newest = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name)
      newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(entryPath) : fs.statSync(entryPath).mtimeMs)
    }
    return newest
  }

  return {
    name: 'wasm-pack-build',
    buildStart() {
      const pkgMtime = fs.existsSync(pkgMarker) ? fs.statSync(pkgMarker).mtimeMs : 0
      const sourceMtime = Math.max(newestSourceMtime(path.join(crateDir, 'src')), fs.statSync(path.join(crateDir, 'Cargo.toml')).mtimeMs)
      if (pkgMtime >= sourceMtime && hasRealPkg()) {
        return
      }
      console.log('[wasm-pack] Rust sources are newer than pkg output, rebuilding WASM package...')
      try {
        execSync('wasm-pack build --target web --out-dir pkg --release', { cwd: crateDir, stdio: 'inherit' })
      } catch (error) {
        console.warn('[wasm-pack] wasm-pack build failed (toolchain likely not installed) - falling back to the JS stub so the build can continue.', error.message)
        ensureWasmPkg()
      }
    }
  }
}

export default defineConfig({
  build: {
    minify: false,
    commonjsOptions: {
      include: [/dist/, /node_modules/]
    },
    target: 'esnext',
    lib: {
      formats: ['es', 'cjs'],
      entry: path.resolve(import.meta.dirname, 'src/index.ts'),
      name: 'gcodeviewer',
      fileName: (format) => `index.${format}.js`
    }
  },
  plugins: [
    wasmPackPlugin(),
    dts()
  ]
})

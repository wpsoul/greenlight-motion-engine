// GreenLight Motion Engine engine bundle: ONE classic script a double-clicked file:// page can load
// (no ES modules, no lazy chunks). `npm run build:motion-engine` → ../motion-engine/dist/.
// See src/motionEngine/engineEntry.jsx and PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md (Part 3).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { createRequire } from 'module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

// The 3D model presets import ~49 MB of .glb files by url; library mode would inline
// them as base64. They stay out of the bundle: a preset's url becomes a marker the
// asset resolver can map to a real file later, and model layers fail soft without it.
function unbundledGlbPlugin() {
  const PREFIX = '\0motion-engine-glb:'
  return {
    name: 'motion-engine-unbundled-glb',
    enforce: 'pre',
    resolveId(id) {
      if (/\.glb\?url$/.test(id)) return PREFIX + path.basename(id.replace(/\?url$/, ''))
      return null
    },
    load(id) {
      if (id.startsWith(PREFIX)) return `export default ${JSON.stringify('motion-engine-unbundled:' + id.slice(PREFIX.length))}`
      return null
    },
  }
}

// App-only modules swapped for stubs in the engine bundle. MotionFast templates stay in
// GreenLight Dash (owner, 2026-10-15): 58 modules / 1.4 MB, 11 of them PRO, and agentic
// templates rebuild those looks from native layers.
function appOnlyStubsPlugin() {
  const stubs = path.resolve(__dirname, 'src/motionEngine/stubs')
  return {
    name: 'motion-engine-app-only-stubs',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === './registry' && importer && /[\\/]motionTemplates[\\/]index\.js$/.test(importer)) {
        return path.join(stubs, 'motionTemplatesRegistry.js')
      }
      return null
    },
  }
}

// The engine's CSS goes INSIDE the script: a Claude artifact may load scripts from jsDelivr but no
// stylesheet except Google Fonts, and a double-clicked page then needs one file, not two.
function inlineCssPlugin() {
  return {
    name: 'motion-engine-inline-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const css = Object.values(bundle).filter((f) => f.type === 'asset' && f.fileName.endsWith('.css'))
      if (!css.length) return
      const text = css.map((f) => String(f.source)).join('\n')
      for (const f of css) delete bundle[f.fileName]
      const inject = `(function(){try{if(typeof document!=='undefined'&&!document.querySelector('style[data-greenlight-motion]')){var s=document.createElement('style');s.setAttribute('data-greenlight-motion','');s.textContent=${JSON.stringify(text)};document.head.appendChild(s);}}catch(e){}})();\n`
      for (const f of Object.values(bundle)) if (f.type === 'chunk' && f.isEntry) f.code = inject + f.code
    },
  }
}

// The page opens the editor's own preset windows (text animation, entrance / exit, transitions; PlayerPage.jsx). Their
// styles live in the app's 750 KB videoEditor.css; `virtual:editor-modal-css` is just the rules they use: every rule
// whose selectors name only classes those windows' source files use (`ve-…` tokens; a token ending in "-" is a
// prefix, for classes built in a template string), the @keyframes they animate with, and, on the windows' root
// (.ve-kfp-overlay), the app's theme variables they read, its font and its `* { margin: 0; padding: 0; box-sizing }`
// reset (at zero specificity, as the app has it). One source of truth: the app's sheet.
function editorModalCssPlugin() {
  const ID = 'virtual:editor-modal-css'
  const RESOLVED = '\0' + ID
  const ve = (f) => path.resolve(__dirname, 'src/components/videoEditor', f)
  const SOURCES = ['KeyframePresetModal.jsx', 'TextAnimatorPresetModal.jsx', 'TransitionPicker.jsx', 'Fields.jsx', 'DirectionPad.jsx']
  return {
    name: 'motion-engine-editor-modal-css',
    resolveId(id) { return id === ID ? RESOLVED : null },
    async load(id) {
      if (id !== RESOLVED) return null
      const fs = await import('node:fs')
      const { default: postcss } = await import('postcss')
      const tokens = new Set()
      for (const f of SOURCES.map(ve)) {
        this.addWatchFile(f)
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bve-[a-z0-9-]+/g)) tokens.add(m[0])
      }
      const prefixes = [...tokens].filter((t) => t.endsWith('-'))
      const known = (c) => tokens.has(c) || prefixes.some((p) => c.startsWith(p))
      const ours = (sel) => {
        const classes = [...sel.matchAll(/\.(ve-[\w-]+)/g)].map((m) => m[1])
        return classes.length > 0 && classes.every(known)
      }
      const sheet = postcss.parse(fs.readFileSync(ve('videoEditor.css'), 'utf8'))
      const animations = new Set()
      sheet.walkComments((c) => c.remove())
      sheet.walkRules((rule) => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
        const keep = rule.selectors.filter(ours)
        if (!keep.length) { rule.remove(); return }
        rule.selectors = keep
        rule.walkDecls(/^animation(-name)?$/, (d) => { for (const w of d.value.split(/[\s,]+/)) animations.add(w) })
      })
      sheet.walkAtRules((at) => { if (/keyframes$/i.test(at.name) && !animations.has(at.params.trim())) at.remove() })
      sheet.walkAtRules((at) => { if (at.nodes && !at.nodes.length) at.remove() })
      // the theme variables the kept rules read (and the ones those read), from the app's first :root
      const theme = {}
      let rootSeen = false
      postcss.parse(fs.readFileSync(path.resolve(__dirname, 'src/index.css'), 'utf8')).walkRules((r) => {
        if (rootSeen || r.selector !== ':root') return
        rootSeen = true
        r.walkDecls(/^--/, (d) => { theme[d.prop] = d.value })
      })
      const wanted = new Set()
      const scan = (value) => {
        for (const m of String(value).matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (wanted.has(m[1]) || !(m[1] in theme)) continue
          wanted.add(m[1])
          scan(theme[m[1]])
        }
      }
      sheet.walkDecls((d) => scan(d.value))
      const vars = [...wanted].map((v) => `${v}: ${theme[v]};`).join(' ')
      const base = [
        ':where(.ve-kfp-overlay, .ve-kfp-overlay *) { margin: 0; padding: 0; box-sizing: border-box; }',
        `.ve-kfp-overlay { ${vars} font-family: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--text-primary); -webkit-font-smoothing: antialiased; }`,
        ':where(.ve-kfp-overlay) :where(button, input, select, textarea) { font-family: inherit; }',
      ].join('\n')
      return `export default ${JSON.stringify(`${base}\n${sheet.toString()}`)};`
    },
  }
}

// Vite leaves lib-mode ES output unminified (so consumers can tree-shake it); nothing will
// tree-shake this engine, and it is loaded whole from jsDelivr, so minify it like the IIFE.
// What went into the bundle (dist/bundle-inputs.json): our source files (repo-relative) and the npm packages with
// their versions — the Web Workers' own bundles included (they are built apart; workerInputsPlugin reports theirs).
// scripts/third-party.mjs writes THIRD_PARTY_LICENSES.md from it; scripts/export-source.mjs builds the public source
// tree from it.
// Every module the build LOADS — also the ones tree-shaking leaves no code from, since the build still resolves them.
const bundleIds = new Set()
function collectModules(ctx) {
  for (const id of ctx.getModuleIds()) bundleIds.add(id.split('?')[0])
}
function workerInputsPlugin() {
  return { name: 'gl-bundle-inputs-worker', generateBundle() { collectModules(this) } }
}
function bundleInputsPlugin() {
  return {
    name: 'gl-bundle-inputs',
    generateBundle() {
      const fs = require('fs');
      const repo = path.resolve(__dirname, '..');
      collectModules(this);
      const ids = bundleIds;
      const sources = new Set();
      const packages = new Map();
      for (const id of ids) {
        if (id.includes('\0')) continue;
        const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id);
        if (pkg) {
          if (!packages.has(pkg[1])) {
            const dir = id.slice(0, id.indexOf('/node_modules/') + '/node_modules/'.length + pkg[1].length);
            const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            packages.set(pkg[1], { name: pkg[1], version: meta.version, license: meta.license || null, dir: path.relative(repo, dir) });
          }
        } else if (id.startsWith(repo + path.sep)) {
          sources.add(path.relative(repo, id));
        }
      }
      const out = path.resolve(__dirname, '../motion-engine/dist');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'bundle-inputs.json'), JSON.stringify({
        sources: [...sources].sort(), packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
      }, null, 1));
    },
  }
}

function minifyEsPlugin() {
  return {
    name: 'motion-engine-minify-es',
    apply: 'build',
    async renderChunk(code, _chunk, options) {
      if (options.format !== 'es') return null
      const { transform } = await import('esbuild')
      const out = await transform(code, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' })
      return { code: out.code, map: null }
    },
  }
}

export default defineConfig({
  plugins: [unbundledGlbPlugin(), appOnlyStubsPlugin(), editorModalCssPlugin(), react(), inlineCssPlugin(), minifyEsPlugin(), bundleInputsPlugin()],
  // The app's public/ folder (templates, HDRs, mediapipe…) is not part of the engine.
  publicDir: false,
  // only reports the workers' modules into dist/bundle-inputs.json; their output is unchanged
  worker: { plugins: () => [workerInputsPlugin()] },
  define: {
    __GL_SELF_HOSTED__: 'false',
    // GreenLightMotion.version: the package's own version, never a hand-kept constant
    __GLM_VERSION__: JSON.stringify(JSON.parse(readFileSync(path.resolve(__dirname, '../motion-engine/package.json'), 'utf8')).version),
    // Library mode doesn't replace process.env; React reads NODE_ENV.
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(''),
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: path.resolve(__dirname, '../motion-engine/dist'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, 'src/motionEngine/engineEntry.jsx'),
      name: 'GreenLightMotionBundle',
      formats: ['iife', 'es'],
      // iife: a classic <script> for a double-clicked page; es: npm, jsDelivr, Claude artifacts.
      fileName: (format) => (format === 'es' ? 'greenlight-motion.mjs' : 'greenlight-motion.js'),
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, assetFileNames: 'greenlight-motion.[ext]' },
    },
  },
})

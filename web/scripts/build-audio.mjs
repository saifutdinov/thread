import { build } from 'vite';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = new URL('../public/audio/', import.meta.url);
await mkdir(target, { recursive: true });
const banner = await readFile(new URL('./audio-globals.js', import.meta.url), 'utf8');
for (const model of ['rnnoise', 'deepfilter']) {
  await build({
    configFile: false, root, publicDir: false,
    plugins: [{
      name: 'deepfilter-compiled-module',
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('@lofcz/deepfilternet-web/dist/index.js')) return;
        // Our worklet always receives a compiled module. Do not emit a second,
        // unused 34 MB model for the package's default URL/stream helpers.
        return code.replaceAll('new URL("./df_bg.wasm", import.meta.url).href', 'undefined').replaceAll('new URL("df_bg.wasm", import.meta.url)', 'undefined').replaceAll('new URL("./worklet.js", import.meta.url)', 'undefined');
      },
    }],
    build: {
      target: 'es2022', outDir: fileURLToPath(target), emptyOutDir: false, minify: true, assetsInlineLimit: 0,
      rollupOptions: {
        input: fileURLToPath(new URL(`../src/lib/${model}-worklet.js`, import.meta.url)),
        output: { format: 'es', entryFileNames: `${model}-worklet.js`, assetFileNames: '[name][extname]', banner, inlineDynamicImports: true },
      },
    },
  });
}
for (const [packageName, file, name] of [
  ['@lofcz/deepfilternet-web', 'LICENSE-MIT', 'DeepFilterNet3-LICENSE-MIT.txt'],
  ['@shiguredo/rnnoise-wasm', 'LICENSE', 'rnnoise-wasm-LICENSE.txt'],
]) await copyFile(new URL(`../node_modules/${packageName}/${file}`, import.meta.url), new URL(name, target));
await copyFile(new URL('../third-party/RNNoise-COPYING.txt', import.meta.url), new URL('RNNoise-COPYING.txt', target));

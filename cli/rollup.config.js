import { importAsString } from 'rollup-plugin-string-import';
import typescript from '@rollup/plugin-typescript';
import json from '@rollup/plugin-json';
const minifiedOutputs = [
  {
    file: "./dist/index.js",
    format: 'esm',
  },
  {
    file:"./dist/index.cjs",
    format: 'cjs',
  },
];

console.log(minifiedOutputs);


/** @type {import('rollup').RollupOptions} */
const config = [{
  input: 'src/index.ts',
  output: minifiedOutputs,
  plugins: [
    importAsString({
      include: ['**/*.txt', '**/*.frag', '**/*.vert', '**/*.sol'],
      exclude: ['**/*.test.*'],
    }),
    json(),
    typescript(),
  ],
}];

export default config;

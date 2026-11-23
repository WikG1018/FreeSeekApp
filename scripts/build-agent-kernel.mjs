import path from 'node:path'
import { rspack } from '@rspack/core'

const root = path.resolve(import.meta.dirname, '..')
const compiler = rspack({
  mode: 'production',
  context: root,
  entry: './src/services/tasks/goalKernel.ts',
  target: ['web', 'es5'],
  output: {
    path: path.join(root, 'dist'),
    filename: 'agent-kernel.js',
    library: { name: 'FreeSeekAgentKernel', type: 'var' },
  },
  resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'builtin:swc-loader',
          options: {
            jsc: { parser: { syntax: 'typescript' } },
            env: { targets: 'ie 11' },
          },
        },
        type: 'javascript/auto',
      },
    ],
  },
  optimization: { minimize: false },
  performance: { hints: false },
})
try {
  const stats = await new Promise((resolve, reject) => {
    compiler.run((error, stats) => (error ? reject(error) : resolve(stats)))
  })
  if (!stats || stats.hasErrors()) {
    throw new Error(stats?.toString({ errors: true }) ?? 'Agent kernel compilation failed')
  }
} finally {
  await new Promise((resolve, reject) =>
    compiler.close((error) => (error ? reject(error) : resolve()))
  )
}

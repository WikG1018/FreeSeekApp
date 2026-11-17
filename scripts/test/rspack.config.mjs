import { createConfig } from '../../rspack.config.ts'

const config = createConfig({
  apiOrigin: process.env.FREESEEK_TEST_API_ORIGIN || 'https://api.review.invalid',
  devServer: {
    host: '127.0.0.1',
    port: Number(process.env.FREESEEK_TEST_PORT) || 8187,
    client: false,
    hot: false,
    liveReload: false,
  },
})
config.entry = './scripts/test/harness.ts'
export default config

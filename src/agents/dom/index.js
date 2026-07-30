import { defineAgent } from '../contract.js'
import { renderDom } from './ui.js'

export const dom = defineAgent({
  id: 'dom',
  title: 'DOM',
  subtitle: 'Post-trade analyst · deterministic stats, then interpretation',
  mount: renderDom,
})

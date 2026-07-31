import { defineAgent } from '../contract.js'
import { renderGnosis } from './ui.js'

export const gnosis = defineAgent({
  id: 'gnosis',
  title: 'Gnosis',
  subtitle: 'Knowledge base · vault scan and preview (apply not enabled)',
  mount: renderGnosis,
})

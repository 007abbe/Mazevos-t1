import { defineAgent } from '../contract.js'
import { renderFinski } from './ui.js'

export const finski = defineAgent({
  id: 'finski',
  title: 'Finski',
  subtitle: 'Pre-market brief · model-risk, events, regime — never direction',
  mount: renderFinski,
})

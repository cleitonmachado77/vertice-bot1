import { formsHomeHash } from './company-switcher.js';

/** Catálogo de apps do Vértice Elo. */
export function availableModules() {
  return [
    {
      id: 'bot',
      name: 'Vértice Bot',
      description: 'Atendimento automatizado no WhatsApp, com passagem para humano',
      href: '#/overview',
      logo: '/logo-vertice-bot.png',
      accent: 'bot',
      available: true,
    },
    {
      id: 'forms',
      name: 'Vértice RSU',
      description: 'Recebimento, separação, prensagem, entrega e vendas integrados ao Odoo',
      href: formsHomeHash(),
      logo: '/logo-vertice-rsu.png',
      accent: 'forms',
      available: true,
    },
    {
      id: 'agro',
      name: 'Vértice Agro',
      description: 'Plantio, colheita, entrega, vendas e custos da empresa ativa',
      href: '#/agro/dashboard',
      logo: '/logo-vertice-agro.png',
      accent: 'agro',
      available: true,
    },
  ].filter((item) => item.available);
}

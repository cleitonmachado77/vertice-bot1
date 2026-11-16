import { formsHomeHash } from './company-switcher.js';

/** Catálogo de apps do Vertice WEB. */
export function availableModules() {
  return [
    {
      id: 'bot',
      name: 'Vertice Bot',
      description: 'Atendimento automatizado no WhatsApp, com passagem para humano',
      href: '#/overview',
      logo: '/logo-vertice-bot.png',
      accent: 'bot',
      available: true,
    },
    {
      id: 'forms',
      name: 'Vértice RSU',
      description: 'Compras, inventário, fabricação e vendas integrados ao Odoo',
      href: formsHomeHash(),
      logo: '/logo-vertice-forms.png',
      accent: 'forms',
      available: true,
    },
    {
      id: 'agro',
      name: 'Vertice Agro',
      description: 'Plantio, colheita, entrega e custos da empresa ativa',
      href: '#/agro/dashboard',
      logo: '/logo-vertice-web.png',
      accent: 'agro',
      available: true,
    },
  ].filter((item) => item.available);
}

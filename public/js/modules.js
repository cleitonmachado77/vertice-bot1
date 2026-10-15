/** Catálogo de apps do Vertice WEB. */
export const modules = [
  {
    id: 'bot',
    name: 'Vertice Bot',
    description: 'Agente WhatsApp, inbox, contatos e questionários.',
    href: '#/overview',
    accent: 'bot',
    available: true,
  },
  {
    id: 'forms',
    name: 'Vertice Forms',
    description: 'Vendas, Compras e Inventário — coleta unificada para o Odoo.',
    href: '#/forms/compras',
    accent: 'forms',
    available: true,
  },
];

export function availableModules() {
  return modules.filter((item) => item.available);
}

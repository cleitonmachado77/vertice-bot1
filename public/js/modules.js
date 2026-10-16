/** Catálogo de apps do Vertice WEB. */
export const modules = [
  {
    id: 'bot',
    name: 'Vertice Bot',
    href: '#/overview',
    logo: '/logo-vertice-bot.png',
    accent: 'bot',
    available: true,
  },
  {
    id: 'forms',
    name: 'Vertice Forms',
    href: '#/forms/compras',
    logo: '/logo-vertice-forms.png',
    accent: 'forms',
    available: true,
  },
];

export function availableModules() {
  return modules.filter((item) => item.available);
}

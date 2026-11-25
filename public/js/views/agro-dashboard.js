import { api } from '../api.js';
import { escapeHtml, statCard } from '../ui.js';

const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

let chartReady = null;
const chartInstances = new Map();
/** Invalida pinturas/carregamentos antigos ao trocar empresa ou período. */
let agroDashEpoch = 0;

const CHART_CDN_CANDIDATES = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.6/+esm',
  'https://unpkg.com/chart.js@4.4.1/auto/+esm',
];

async function loadChartJs() {
  if (chartReady) return chartReady;
  chartReady = (async () => {
    let lastError = null;
    for (const url of CHART_CDN_CANDIDATES) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        const Chart = mod.Chart || mod.default;
        if (!Chart) throw new Error('Chart.js sem export Chart');
        if (mod.BarController && mod.BarElement && mod.CategoryScale && mod.LinearScale) {
          Chart.register(
            mod.BarController,
            mod.BarElement,
            mod.CategoryScale,
            mod.LinearScale,
            mod.Legend,
            mod.Tooltip,
          );
        }
        return { Chart };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Não foi possível carregar Chart.js');
  })().catch((error) => {
    chartReady = null;
    throw error;
  });
  return chartReady;
}

function destroyCharts() {
  for (const chart of chartInstances.values()) {
    try {
      chart.destroy();
    } catch {
      /* ignore */
    }
  }
  chartInstances.clear();
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null || value === '') return 0;
  if (typeof value === 'object') {
    const nested = value.y ?? value.value ?? value.qty;
    if (typeof nested === 'number') return Number.isFinite(nested) ? nested : 0;
    if (typeof nested === 'string' && nested.trim() !== '') {
      const parsedNested = Number(nested);
      return Number.isFinite(parsedNested) ? parsedNested : 0;
    }
    return 0;
  }
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function formatQty(value) {
  return toNumber(value).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function formatMoney(value) {
  return toNumber(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2,
  });
}

function yearOptions(selected) {
  const now = new Date().getFullYear();
  const years = [];
  // Inclui anos futuros para previsão/estimativa de safra (ex.: plantio em 2026 → colheita 2027).
  for (let y = now + 2; y >= now - 6; y -= 1) years.push(y);
  if (selected && !years.includes(selected)) years.push(selected);
  years.sort((a, b) => b - a);
  return years
    .map((y) => `<option value="${y}"${y === selected ? ' selected' : ''}>${y}</option>`)
    .join('');
}

function monthOptions(selected) {
  return MONTHS.map(
    (label, index) =>
      `<option value="${index + 1}"${index + 1 === selected ? ' selected' : ''}>${label}</option>`,
  ).join('');
}

function periodPicker(period) {
  const month = period?.month || new Date().getMonth() + 1;
  const year = period?.year || new Date().getFullYear();
  return `
    <div class="hub-period agro-period" role="group" aria-label="Período">
      <span class="hub-period-label">Período</span>
      <select id="agro-dash-month" aria-label="Mês">${monthOptions(month)}</select>
      <select id="agro-dash-year" aria-label="Ano">${yearOptions(year)}</select>
    </div>`;
}

function productFilter(products, selected) {
  return `
    <label class="agro-dash-product">Cultura
      <select id="agro-dash-product" aria-label="Filtrar indicadores por cultura">
        <option value="">Todas</option>
        ${(products || [])
          .map(
            (item) =>
              `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`,
          )
          .join('')}
      </select>
    </label>`;
}

function sectionCard(id, title, hint = '', featuredOrEmpty = false, emptyFallback = 'Sem dados neste período') {
  const featured = featuredOrEmpty === true;
  const emptyText = typeof featuredOrEmpty === 'string' ? featuredOrEmpty : emptyFallback;
  return `
    <section class="card agro-dash-card${featured ? ' agro-dash-card--featured' : ''}" data-chart="${escapeHtml(id)}">
      <header class="agro-dash-card-head">
        <h3>${escapeHtml(title)}</h3>
        ${hint ? `<p class="muted" data-chart-hint="${escapeHtml(id)}">${escapeHtml(hint)}</p>` : ''}
      </header>
<div class="agro-dash-chart-wrap${featured ? ' agro-dash-chart-wrap--featured' : ''}">
        <canvas id="agro-chart-${escapeHtml(id)}" height="${featured ? 320 : 220}" aria-label="${escapeHtml(title)}"></canvas>
        <p class="agro-dash-empty muted" id="agro-chart-empty-${escapeHtml(id)}" hidden>${escapeHtml(emptyText)}</p>
      </div>
      ${featured ? '<div class="agro-dash-forecast-panel" id="agro-forecast-panel" hidden></div>' : ''}
    </section>`;
}

function formatDay(iso) {
  const raw = String(iso || '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return raw || '—';
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function formatDayShort(iso) {
  const raw = String(iso || '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return raw || '—';
  return `${match[3]}/${match[2]}`;
}

function digitsPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function whatsappHref(phone) {
  const digits = digitsPhone(phone);
  if (!digits) return '';
  const withCountry = digits.length >= 12 ? digits : digits.length >= 10 ? `55${digits}` : '';
  return withCountry ? `https://wa.me/${withCountry}` : '';
}

function telHref(phone) {
  const digits = digitsPhone(phone);
  return digits ? `tel:+${digits.length >= 12 ? digits : digits.length >= 10 ? `55${digits}` : digits}` : '';
}

function printForecastContacts(contacts, period) {
  const monthLabel = MONTHS[(period?.month || 1) - 1] || '';
  const year = period?.year || '';
  const rows = (contacts || [])
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.name || '—')}</td>
        <td>${escapeHtml(item.phone || '—')}</td>
        <td>${escapeHtml((item.products || []).join(', ') || '—')}</td>
        <td>${escapeHtml(formatDay(item.nextDate))}</td>
        <td>${escapeHtml((item.properties || []).join(', ') || '—')}</td>
        <td>${escapeHtml(formatQty(item.qty))}</td>
      </tr>`,
    )
    .join('');
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Produtores a contatar — ${escapeHtml(monthLabel)}/${escapeHtml(String(year))}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; color: #1a1a1a; margin: 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { color: #555; margin: 0 0 16px; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; }
</style></head><body>
  <h1>Produtores a contatar</h1>
  <p>Estimativa de produção · plantios em aberto · ${escapeHtml(monthLabel)}/${escapeHtml(String(year))}</p>
  <table>
    <thead>
      <tr>
        <th>Produtor</th><th>Telefone</th><th>Culturas</th>
        <th>Próxima colheita</th><th>Propriedades</th><th>Estimativa</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="6">Nenhum produtor no período</td></tr>'}</tbody>
  </table>
  <script>window.onload = () => { window.print(); };<\/script>
</body></html>`;
  const popup = window.open('', '_blank', 'noopener,noreferrer,width=960,height=720');
  if (!popup) return;
  popup.document.open();
  popup.document.write(html);
  popup.document.close();
}

function renderForecastPanel(forecast, period) {
  const panel = document.getElementById('agro-forecast-panel');
  if (!panel) return;
  const rows = forecast?.timeline || [];
  const contacts = forecast?.contacts || [];
  if (!rows.length && !contacts.length) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `
    <div class="agro-dash-forecast-table-wrap">
      <p class="agro-dash-forecast-caption"><strong>Quando colher</strong> — data prevista (plantios em aberto)</p>
      <table class="agro-dash-forecast-table">
        <thead>
          <tr>
            <th>Data prevista</th>
            <th>Cultura</th>
            <th>Colheita</th>
            <th>Área</th>
            <th>Produtor</th>
            <th>Estimativa</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
            <tr>
              <td><span class="agro-forecast-date">${escapeHtml(formatDay(row.date))}</span></td>
              <td>${escapeHtml(row.product || '—')}</td>
              <td>#${escapeHtml(String(row.harvestIndex || 1))}</td>
              <td>${escapeHtml(row.plotName || row.propertyName || '—')}</td>
              <td>${escapeHtml(row.producerName || '—')}${
                row.producerPhone
                  ? `<span class="agro-sub">${escapeHtml(row.producerPhone)}</span>`
                  : ''
              }</td>
              <td>${escapeHtml(formatQty(row.qty))}${row.unit ? ` ${escapeHtml(row.unit)}` : ''}</td>
            </tr>`,
            )
            .join('') || '<tr><td colspan="6" class="muted">Sem colheitas previstas neste período</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="agro-dash-contacts" id="agro-forecast-contacts">
      <header class="agro-dash-contacts-head">
        <div>
          <h4>Produtores a contatar</h4>
          <p class="muted">Quem tem colheita prevista no período — telefone para contato</p>
        </div>
        <button type="button" class="btn-ghost" data-print-forecast-contacts ${
          contacts.length ? '' : 'disabled'
        }>Exportar / imprimir</button>
      </header>
      ${
        contacts.length
          ? `<ul class="agro-dash-contacts-list">
        ${contacts
          .map((item) => {
            const tel = telHref(item.phone);
            const wa = whatsappHref(item.phone);
            return `<li class="agro-dash-contact-card">
              <div class="agro-dash-contact-main">
                <strong>${escapeHtml(item.name || '—')}</strong>
                <span class="agro-forecast-date">${escapeHtml(formatDay(item.nextDate))}</span>
              </div>
              <p class="agro-sub">${escapeHtml((item.products || []).join(' · ') || '—')}</p>
              <p class="agro-sub">${escapeHtml((item.properties || []).join(' · ') || '')}</p>
              <div class="agro-dash-contact-actions">
                ${
                  item.phone
                    ? `<span class="agro-dash-contact-phone">${escapeHtml(item.phone)}</span>`
                    : '<span class="muted">Sem telefone</span>'
                }
                ${tel ? `<a class="btn-ghost agro-mini" href="${escapeHtml(tel)}">Ligar</a>` : ''}
                ${
                  wa
                    ? `<a class="btn-ghost agro-mini" href="${escapeHtml(wa)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`
                    : ''
                }
              </div>
            </li>`;
          })
          .join('')}
      </ul>`
          : '<p class="muted">Nenhum produtor com colheita prevista neste filtro.</p>'
      }
    </div>`;

  panel.querySelector('[data-print-forecast-contacts]')?.addEventListener('click', () => {
    printForecastContacts(contacts, period);
  });
}

function formatHa(value) {
  return `${formatQty(value)} ha`;
}

function summaryCards(summary) {
  return [
    statCard({
      label: 'Área plantada atual',
      value: formatHa(summary?.plantedAreaHa),
      tone: 'green',
      icon: 'sprout',
      title: 'Soma da área (ha) dos plantios ativos',
    }),
    statCard({
      label: 'Produção estimada',
      value: formatQty(summary?.estimatedQty),
      tone: 'teal',
      icon: 'chart',
      title: 'Soma da produção estimada dos plantios ativos',
    }),
    statCard({
      label: 'Coheita realizada',
      value: formatQty(summary?.harvestedQty),
      tone: 'amber',
      icon: 'harvest',
      title: 'Soma das colheitas no período',
    }),
    statCard({
      label: 'Produção entregue',
      value: formatQty(summary?.deliveredQty),
      tone: 'orange',
      icon: 'truck',
      title: 'Soma da produção entregue no período',
    }),
    statCard({
      label: 'Valor vendido',
      value: formatMoney(summary?.soldValue),
      tone: 'blue',
      icon: 'sales',
      title: 'Faturamento das entregas no período',
    }),
    statCard({
      label: 'Custos de produção',
      value: formatMoney(summary?.costs),
      tone: 'navy',
      icon: 'money',
      title: 'Soma dos custos de produção no período',
    }),
  ].join('');
}

/** Plugin local: total sempre visível na barra (não só no hover). */
const barValueLabels = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart) {
    try {
      const { ctx, chartArea } = chart;
      if (!ctx) return;
      const format = chart.options.plugins?.barValueLabels?.format || formatQty;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '600 11px Outfit, "Segoe UI", sans-serif';
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        if (!meta || meta.hidden) return;
        meta.data.forEach((element, index) => {
          if (!element || typeof element.getProps !== 'function') return;
          const raw = toNumber(dataset.data[index]);
          if (!raw) return;
          const { x, y, base } = element.getProps(['x', 'y', 'base'], true);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(base)) return;
          let text = '';
          try {
            text = String(format(raw) ?? '');
          } catch {
            text = String(raw);
          }
          if (!text) return;
          const barHeight = Math.abs(base - y);
          const inside = barHeight > 22;
          ctx.textBaseline = inside ? 'top' : 'bottom';
          ctx.fillStyle = inside ? '#ffffff' : '#3a3a3e';
          const ty = inside ? Math.min(y + 6, (chartArea?.bottom || y) - 4) : y - 4;
          ctx.fillText(text, x, ty);
        });
      });
      ctx.restore();
    } catch {
      /* nunca derrubar o Chart por rótulo */
    }
  },
};

function setChartEmpty(canvas, empty) {
  const emptyEl = document.getElementById(`agro-chart-empty-${canvas.id.replace(/^agro-chart-/, '')}`);
  canvas.hidden = Boolean(empty);
  if (emptyEl) emptyEl.hidden = !empty;
}

/** Paleta por cultura/produção (barras distintas no gráfico de estimativa). */
const PRODUCT_BAR_COLORS = [
  '#1f7a5c',
  '#2b5aa8',
  '#d4a017',
  '#c45c26',
  '#6b4c9a',
  '#0e7490',
  '#b45309',
  '#be185d',
  '#15803d',
  '#4338ca',
  '#a16207',
  '#dc2626',
];

function colorsForLabels(labels, fallback = '#2e8b57') {
  if (!labels?.length) return fallback;
  return labels.map((_, index) => PRODUCT_BAR_COLORS[index % PRODUCT_BAR_COLORS.length]);
}

function colorForProduct(product, index = 0) {
  return PRODUCT_BAR_COLORS[index % PRODUCT_BAR_COLORS.length];
}

/** Gráfico featured: eixo X = data, barras empilhadas por produto. */
function makeForecastByDate(Chart, canvas, byDate) {
  const dates = byDate?.dates || [];
  const series = byDate?.series || [];
  const hasData = series.some((item) => (item.values || []).some((value) => Number(value) > 0));
  setChartEmpty(canvas, !hasData || !dates.length);
  if (!hasData || !dates.length) return;

  const existing = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      /* ignore */
    }
  }

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: dates.map((date) => formatDayShort(date)),
      datasets: series.map((item, index) => ({
        label: item.product,
        data: item.values || [],
        backgroundColor: colorForProduct(item.product, index),
        borderRadius: 6,
        maxBarThickness: 42,
        stack: 'forecast',
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 22, right: 8 } },
      plugins: {
        legend: {
          display: series.length > 1,
          position: 'bottom',
          labels: { boxWidth: 12, boxHeight: 12, padding: 12 },
        },
        barValueLabels: { format: formatQty },
        tooltip: {
          callbacks: {
            title(items) {
              const idx = items?.[0]?.dataIndex ?? 0;
              return formatDay(dates[idx] || '');
            },
            label(ctx) {
              const value = Number(ctx.parsed.y || 0);
              if (!value) return null;
              return `${ctx.dataset.label}: ${formatQty(value)}`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { autoSkip: true, maxRotation: 0, minRotation: 0 },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            precision: 0,
            callback(value) {
              return formatQty(value);
            },
          },
        },
      },
    },
    plugins: [barValueLabels],
  });
  chartInstances.set(canvas.id, chart);
  setChartEmpty(canvas, false);
}

function makeBar(Chart, canvas, labels, values, label, color = '#2e8b57', format = formatQty) {
  const hasData = values.some((value) => Number(value) > 0);
  setChartEmpty(canvas, !hasData);
  if (!hasData) return;

  const existing = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      /* ignore */
    }
  }

  const backgroundColor = Array.isArray(color) ? color : color;

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          backgroundColor,
          borderRadius: 8,
          maxBarThickness: 48,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 22, right: 8 } },
      plugins: {
        legend: { display: false },
        barValueLabels: { format },
        tooltip: {
          callbacks: {
            label(ctx) {
              const name = labels[ctx.dataIndex] || ctx.dataset.label;
              return `${name}: ${format(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { autoSkip: false, maxRotation: 0, minRotation: 0 },
        },
        y: {
          beginAtZero: true,
          ticks: {
            precision: 0,
            callback(value) {
              return format(value);
            },
          },
        },
      },
    },
    plugins: [barValueLabels],
  });
  chartInstances.set(canvas.id, chart);
  setChartEmpty(canvas, false);
}

function makeGrouped(Chart, canvas, rows) {
  const hasData = rows.some((item) => Number(item.revenue) > 0 || Number(item.expense) > 0);
  setChartEmpty(canvas, !hasData);
  if (!hasData) return;

  const existing = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      /* ignore */
    }
  }

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((item) => item.label),
      datasets: [
        {
          label: 'Receita',
          data: rows.map((item) => item.revenue),
          backgroundColor: '#2e8b57',
          borderRadius: 8,
          maxBarThickness: 28,
        },
        {
          label: 'Despesas',
          data: rows.map((item) => item.expense),
          backgroundColor: '#c45c26',
          borderRadius: 8,
          maxBarThickness: 28,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 22, right: 8 } },
      plugins: {
        legend: { position: 'bottom' },
        barValueLabels: { format: formatMoney },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return formatMoney(value);
            },
          },
        },
      },
    },
    plugins: [barValueLabels],
  });
  chartInstances.set(canvas.id, chart);
  setChartEmpty(canvas, false);
}

/** Pintura síncrona — sem await entre montar o DOM e criar os charts (evita canvas em branco). */
function paintChartsSync(Chart, data) {
  Chart.defaults.color = '#6b6b70';
  Chart.defaults.borderColor = 'rgba(26, 26, 28, 0.06)';
  Chart.defaults.font.family = 'Outfit, "Segoe UI", sans-serif';
  destroyCharts();

  const forecastCanvas = document.getElementById('agro-chart-forecast');
  const forecastHint = document.querySelector('[data-chart-hint="forecast"]');
  if (forecastHint) {
    if (data.forecast?.showingUpcoming) {
      forecastHint.textContent =
        'Nenhuma colheita no mês filtrado — próximas datas dos plantios em aberto (eixo por data).';
    } else if (data.scope === 'all') {
      forecastHint.textContent =
        'Por data prevista · plantios em aberto · todas as empresas (filtre por cultura)';
    } else {
      forecastHint.textContent =
        'Por data prevista · plantios em aberto (filtre por cultura no seletor)';
    }
  }
  if (forecastCanvas?.isConnected) {
    try {
      makeForecastByDate(Chart, forecastCanvas, data.forecast?.byDate || { dates: [], series: [] });
    } catch (error) {
      console.warn('[agro-dash] falha no gráfico forecast', error);
      if (!chartInstances.has(forecastCanvas.id)) setChartEmpty(forecastCanvas, true);
      else setChartEmpty(forecastCanvas, false);
    }
  }
  renderForecastPanel(data.forecast || {}, data.period);

  const pairs = [
    ['planting', data.plantingByProduct || [], 'Plantado', '#3d8b6e', formatQty],
    ['harvest', data.harvestByProduct || [], 'Colheita', '#d4a017', formatQty],
    ['delivery', data.deliveryByProduct || [], 'Entrega', '#c45c26', formatQty],
    ['sales', data.salesByProduct || [], 'Venda (R$)', '#2b5aa8', formatMoney],
    ['stock', data.stockByProduct || [], 'Estoque', '#1f7a5c', formatQty],
    ['costs', data.costsByArea || [], 'Custos por área', '#8b4513', formatMoney],
  ];
  for (const [id, rows, label, color, format] of pairs) {
    const canvas = document.getElementById(`agro-chart-${id}`);
    if (!canvas || !canvas.isConnected) continue;
    try {
      makeBar(
        Chart,
        canvas,
        rows.map((item) => item.label),
        rows.map((item) => item.value),
        label,
        color,
        format,
      );
      if (id === 'stock' && !(rows || []).some((item) => Number(item.value) > 0)) {
        const emptyEl = document.getElementById('agro-chart-empty-stock');
        const harvested = Number(data.summary?.harvestedQty || 0);
        const delivered = Number(data.summary?.deliveredQty || 0);
        if (emptyEl) {
          emptyEl.textContent =
            harvested > 0 && delivered >= harvested - 0.0001
              ? 'Sem saldo: a colheita já foi entregue'
              : harvested > 0
                ? 'Sem saldo em estoque (colhido − entregue)'
                : 'Sem saldo em estoque';
        }
      }
    } catch (error) {
      console.warn(`[agro-dash] falha no gráfico ${id}`, error);
      if (!chartInstances.has(canvas.id)) setChartEmpty(canvas, true);
      else setChartEmpty(canvas, false);
    }
  }
  const revenueCanvas = document.getElementById('agro-chart-revenue');
  if (revenueCanvas?.isConnected) {
    try {
      makeGrouped(Chart, revenueCanvas, data.revenueExpenseByArea || []);
    } catch (error) {
      console.warn('[agro-dash] falha no gráfico revenue', error);
      if (!chartInstances.has(revenueCanvas.id)) setChartEmpty(revenueCanvas, true);
      else setChartEmpty(revenueCanvas, false);
    }
  }
}

async function paint(root, data, productFilterValue = '', epoch = agroDashEpoch) {
  if (epoch !== agroDashEpoch) return;

  // Chart.js ANTES de tocar no DOM: se a epoch mudar no await, não deixamos cards vazios.
  let Chart;
  try {
    ({ Chart } = await loadChartJs());
  } catch (error) {
    if (epoch !== agroDashEpoch) return;
    destroyCharts();
    const actions = root.querySelector('#agro-dash-actions') || root.querySelector('.forms-top-actions');
    if (actions) {
      actions.innerHTML = `${productFilter(data.products, productFilterValue)}${periodPicker(data.period)}`;
    }
    const body = root.querySelector('#agro-body');
    if (!body) return;
    body.innerHTML = `
      <div class="stat-row agro-dash-stats" aria-label="Resumo agro">${summaryCards(data.summary)}</div>
      <p class="muted agro-dash-chart-error">Gráficos indisponíveis: ${escapeHtml(error.message || 'falha ao carregar Chart.js')}</p>`;
    return;
  }
  if (epoch !== agroDashEpoch) return;

  destroyCharts();
  const actions = root.querySelector('#agro-dash-actions') || root.querySelector('.forms-top-actions');
  if (actions) {
    actions.innerHTML = `${productFilter(data.products, productFilterValue)}${periodPicker(data.period)}`;
  }
  const body = root.querySelector('#agro-body');
  if (!body) return;
  body.innerHTML = `
    <div class="stat-row agro-dash-stats" aria-label="Resumo agro">${summaryCards(data.summary)}</div>
    <div class="agro-dash-grid">
${sectionCard(
        'forecast',
        'Estimativa de produção',
        'Por data prevista · plantios em aberto (filtre por cultura no seletor)',
        true,
      )}
      ${sectionCard('planting', 'Plantio', 'Quantidade plantada por produto no período')}
      ${sectionCard('harvest', 'Colheita', 'Unidade por produto')}
      ${sectionCard('delivery', 'Entrega', 'Unidade por produto')}
      ${sectionCard('sales', 'Venda', 'R$ por produto')}
      ${sectionCard('stock', 'Estoque', 'Saldo atual: colhido − entregue', 'Sem saldo em estoque')}
      ${sectionCard('costs', 'Custos por área', 'Talhão')}
      ${sectionCard('revenue', 'Receita × Despesas por área', 'Colheita × preço médio vs custos')}
    </div>
    <p class="muted agro-dash-chart-error" id="agro-dash-chart-error" hidden></p>`;
  if (epoch !== agroDashEpoch) return;
  paintChartsSync(Chart, data);
}

export function stopAgroDashboard() {
  agroDashEpoch += 1;
  destroyCharts();
}

export async function renderAgroDashboard(root) {
  const epoch = (agroDashEpoch += 1);
  destroyCharts();
  // Pré-aquece Chart.js em paralelo com o fetch (não bloqueia o DOM).
  const chartWarm = loadChartJs().catch(() => null);
  const body = root.querySelector('#agro-body');
  if (body) body.innerHTML = `<p class="muted">Carregando indicadores…</p>`;
  const now = new Date();
  const state = root._agroDashState || {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    product: '',
    companyId: '',
  };
  root._agroDashState = state;

  const load = async ({ resetProduct = false } = {}) => {
    const loadEpoch = (agroDashEpoch += 1);
    if (resetProduct) state.product = '';
    const targetBody = root.querySelector('#agro-body');
    if (targetBody) targetBody.innerHTML = `<p class="muted">Carregando indicadores…</p>`;
    const qs = new URLSearchParams({
      month: String(state.month),
      year: String(state.year),
    });
    if (state.product) qs.set('productId', state.product);
    const [data] = await Promise.all([api(`/api/agro/dashboard?${qs}`), chartWarm]);
    if (loadEpoch !== agroDashEpoch) return;
    state.companyId = String(data.companyId || state.companyId || '');
    await paint(root, data, state.product, loadEpoch);
  };
  root._agroDashLoad = load;

  if (root.dataset.agroDashBound !== '1') {
    root.dataset.agroDashBound = '1';
    root.addEventListener('change', (event) => {
      const current = root._agroDashState;
      if (!current) return;
      const targetBody = root.querySelector('#agro-body');
      if (event.target?.id === 'agro-dash-month') {
        current.month = Number(event.target.value);
        load().catch((error) => {
          if (targetBody && agroDashEpoch) {
            targetBody.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Falha ao carregar')}</p>`;
          }
        });
        return;
      }
      if (event.target?.id === 'agro-dash-year') {
        current.year = Number(event.target.value);
        load().catch((error) => {
          if (targetBody) {
            targetBody.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Falha ao carregar')}</p>`;
          }
        });
        return;
      }
      if (event.target?.id === 'agro-dash-product') {
        current.product = event.target.value;
        load().catch(() => {});
      }
    });
  }

  try {
    if (epoch !== agroDashEpoch) return;
    await load({ resetProduct: true });
  } catch (error) {
    if (epoch !== agroDashEpoch && agroDashEpoch > epoch) return;
    const currentBody = root.querySelector('#agro-body');
    if (currentBody) {
      currentBody.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Não foi possível carregar o dashboard')}</p>`;
    }
  }
}

import { escapeHtml } from '../ui.js';

const STATUS = {
  planejado: 'Planejado',
  em_colheita: 'Em colheita',
  colhido: 'Colhido',
};

function option(value, label, selected, attrs = '') {
  const mark = String(value) === String(selected) ? 'selected' : '';
  return `<option value="${escapeHtml(value)}" ${attrs} ${mark}>${escapeHtml(label)}</option>`;
}

function plantingLabel(item) {
  const plot = item.plotName ? ` · ${item.plotName}` : '';
  return `${item.propertyName}${plot} · ${item.productName}`;
}

export function plantingChoices(plantings, selected, mode) {
  return (plantings || []).filter((item) => {
    if (item.id === selected) return true;
    if (mode === 'harvest') return item.status !== 'colhido';
    const remaining = Number(item.harvestedQty || 0) - Number(item.deliveredQty || 0);
    return remaining > 0.0001;
  });
}

function looseNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function syncDeliveryTotal(form) {
  syncQtyPriceTotal(form);
}

/** Valor total = quantidade × unitário (entrega e custo). */
export function syncQtyPriceTotal(form) {
  const target = form.querySelector('[data-total]');
  if (!target) return;
  const quantity = looseNumber(form.quantity?.value);
  const price = looseNumber(form.unitPrice?.value);
  target.value =
    quantity != null && price != null
      ? (Math.round(quantity * price * 100) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : '';
}

function moneyReadonly(value) {
  if (value == null || value === '') return '';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return parsed.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function addDaysIso(isoDate, days) {
  const raw = String(isoDate || '').trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match || !Number.isFinite(days) || days <= 0) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Math.trunc(days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function haLabel(value) {
  if (value == null || value === '') return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return `${parsed.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ha`;
}

function syncPlantingDerived(form, catalog) {
  const propertyId = form.propertyId?.value || '';
  const plotId = form.plotId?.value || '';
  const properties = catalog?.properties || [];
  const farmProducers = catalog?.farmProducers || [];
  const property =
    properties.find((item) => item.id === propertyId) ||
    farmProducers.flatMap((item) => item.properties || []).find((item) => item.id === propertyId);
  const plot = (property?.plots || []).find((item) => item.id === plotId);
  const area = plot?.area;
  if (form.areaPlanned) {
    form.areaPlanned.value = area != null && Number(area) > 0 ? String(area) : '';
  }
  const areaHelp = form.querySelector('[data-plot-area]');
  if (areaHelp) {
    areaHelp.textContent =
      area != null && Number(area) > 0
        ? `Área do talhão: ${haLabel(area)}`
        : 'Cadastre a área do talhão em Configurações.';
  }

  const productId = form.productId?.value || '';
  const product = (catalog?.products || []).find((item) => item.id === productId);
  const plantedOn = form.plantedOn?.value || '';
  const cycleDays = product?.cycleDays != null ? Number(product.cycleDays) : NaN;
  const yieldPerHa = product?.yieldPerHa != null ? Number(product.yieldPerHa) : NaN;
  const forecastOn = addDaysIso(plantedOn, cycleDays);
  const areaNum = area != null ? Number(area) : NaN;
  const forecastQty =
    Number.isFinite(yieldPerHa) && yieldPerHa > 0 && Number.isFinite(areaNum) && areaNum > 0
      ? Math.round(areaNum * yieldPerHa * 1000) / 1000
      : null;
  if (form.forecastOn) form.forecastOn.value = forecastOn;
  if (form.forecastQty) form.forecastQty.value = forecastQty == null ? '' : String(forecastQty);
  const hint = form.querySelector('[data-forecast-hint]');
  if (hint) {
    const missing = [];
    if (!Number.isFinite(cycleDays) || cycleDays <= 0) missing.push('dias até a colheita');
    if (!Number.isFinite(yieldPerHa) || yieldPerHa <= 0) missing.push('produtividade / ha');
    hint.textContent = missing.length
      ? `Preencha ${missing.join(' e ')} no cadastro do produto para calcular automaticamente.`
      : 'Calculado pelos parâmetros do produto (dias e produtividade / ha).';
  }
}

export function syncPlantingForm(form, catalog) {
  const farmProducers = catalog?.farmProducers || [];
  const producerId = form.producerId?.value || '';
  const producer = farmProducers.find((item) => item.id === producerId);
  const properties = producer?.properties || [];
  const propertySelect = form.propertyId;
  if (propertySelect) {
    const currentProperty = propertySelect.dataset.current || propertySelect.value;
    delete propertySelect.dataset.current;
    propertySelect.innerHTML = [
      option('', 'Selecione', ''),
      ...properties.map((item) => option(item.id, item.name, currentProperty)),
    ].join('');
    const available = [...propertySelect.options].some((item) => item.value === currentProperty && currentProperty);
    propertySelect.value = available ? currentProperty : properties[0]?.id || '';
  }

  const propertyId = form.propertyId?.value || '';
  const property = properties.find((item) => item.id === propertyId) ||
    (catalog?.properties || []).find((item) => item.id === propertyId);
  const plot = form.plotId;
  if (plot) {
    const current = plot.dataset.current || plot.value;
    delete plot.dataset.current;
    const plots = property?.plots || [];
    plot.innerHTML = [
      option('', 'Selecione', ''),
      ...plots.map((item) =>
        option(
          item.id,
          item.label || item.name,
          current,
          `data-area="${escapeHtml(item.area ?? '')}"`,
        ),
      ),
    ].join('');
    const available = [...plot.options].some((item) => item.value === current && current !== '');
    plot.value = available ? current : plots[0]?.id || '';
  }
  const custom = form.querySelector('[data-custom-product]');
  if (custom) custom.hidden = form.productId?.value !== '__custom__';
  if (form.productId?.value && form.productId.value !== '__custom__') {
    const chosen = form.productId.selectedOptions?.[0];
    const unit = chosen?.dataset?.uom || '';
    if (unit && form.unit) form.unit.value = unit;
  }
  syncPlantingDerived(form, catalog);
}

function suggestDeliveryPrice(form, catalog, plantings) {
  const price = form.unitPrice;
  if (!price || price.dataset.touched === '1') return;
  const planting = (plantings || []).find((item) => item.id === form.plantingId?.value);
  const product = (catalog?.products || []).find((item) => item.id && item.id === planting?.productId);
  const suggested = String(product?.salesPrice || '').trim();
  if (!suggested) return;
  if (String(price.value || '').trim() && price.dataset.suggested !== '1') return;
  price.value = suggested;
  price.dataset.suggested = '1';
}

export function syncDeliveryForm(form, catalog, plantings) {
  const box = form.querySelector('[data-custom-buyer]');
  if (box) box.hidden = form.partnerId?.value !== '__custom__';
  suggestDeliveryPrice(form, catalog, plantings);
  syncDeliveryTotal(form);
}

export function readAgroForm(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = String(value);
  });
  if (form.close) data.close = form.close.checked;
  return data;
}

function actions(extra = '') {
  return `
    <div class="agro-form-actions">
      <button class="btn" type="submit">Salvar</button>
      <button class="btn-ghost" type="button" data-close-modal>Cancelar</button>
      ${extra}
    </div>`;
}

function removeButton() {
  return `<button class="btn-danger" type="button" data-delete-modal>Excluir</button>`;
}

export function plantingFormHtml(item, catalog) {
  const farmProducers = catalog?.farmProducers || [];
  const properties = catalog?.properties || [];
  const products = catalog?.products || [];
  const selectedProducer =
    item?.producerId ||
    properties.find((property) => property.id === item?.propertyId)?.producerId ||
    farmProducers.find((producer) => producer.partnerId && producer.partnerId === item?.producerPartnerId)?.id ||
    farmProducers[0]?.id ||
    '';
  const producerProperties = farmProducers.find((producer) => producer.id === selectedProducer)?.properties || properties;
  const selectedProperty = item?.propertyId || producerProperties[0]?.id || '';
  const selectedProduct = item ? item.productId || '__custom__' : '';
  const knownProduct = products.some((product) => product.id === selectedProduct);
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item ? 'Editar plantio' : 'Novo plantio'}</h2>
        <p class="muted">Área vem do talhão; previsão e estimativa saem dos parâmetros do produto.</p>
      </div>
    </header>
    <form id="agro-form" class="agro-form" data-kind="plantio">
      ${
        farmProducers.length
          ? ''
          : '<p class="muted">Cadastre o produtor e a propriedade em <a href="#/agro/configuracoes">Configurações</a> antes de lançar o plantio.</p>'
      }
      <label>Produtor
        <select name="producerId" required>
          ${option('', 'Selecione', selectedProducer)}
          ${farmProducers.map((producer) => option(producer.id, producer.name, selectedProducer)).join('')}
        </select>
      </label>
      <div class="grid-2">
        <label>Propriedade
          <select name="propertyId" data-current="${escapeHtml(selectedProperty)}" required>
            ${option('', 'Selecione', '')}
          </select>
        </label>
        <label>Talhão
          <select name="plotId" data-current="${escapeHtml(item?.plotId || '')}" required>
            ${option('', 'Selecione', '')}
          </select>
        </label>
      </div>
      <p class="muted" data-plot-area>Área do talhão: —</p>
      <input type="hidden" name="areaPlanned" value="${escapeHtml(item?.areaPlanned ?? '')}">
      <label>Produto
        <select name="productId" required>
          ${option('', 'Selecione', selectedProduct)}
          ${!knownProduct && item?.productId ? option(item.productId, item.productName, selectedProduct) : ''}
          ${products
            .map((product) =>
              option(
                product.id,
                product.uom ? `${product.name} · ${product.uom}` : product.name,
                selectedProduct,
                `data-uom="${escapeHtml(product.uom)}"`,
              ),
            )
            .join('')}
          ${option('__custom__', 'Outra cultura', selectedProduct)}
        </select>
      </label>
      <div class="grid-2" data-custom-product hidden>
        <label>Nome da cultura<input name="productName" maxlength="150" value="${escapeHtml(item && !item.productId ? item.productName : '')}"></label>
        <label>Unidade<input name="unit" maxlength="20" value="${escapeHtml(item?.unit || '')}" placeholder="kg, sc, t"></label>
      </div>
      <label>Data do plantio<input name="plantedOn" type="date" required value="${escapeHtml(item?.plantedOn || '')}"></label>
      <div class="grid-2">
        <label>Previsão de colheita
          <input name="forecastOn" type="date" readonly value="${escapeHtml(item?.forecastOn || '')}">
        </label>
        <label>Estimativa da safra
          <input name="forecastQty" inputmode="decimal" readonly value="${escapeHtml(item?.forecastQty ?? '')}" placeholder="Calculada pelo produto">
        </label>
      </div>
      <p class="muted" data-forecast-hint>Calculado pelos parâmetros do produto (dias e produtividade / ha).</p>
      ${
        item
          ? `<label>Situação
              <select name="status">
                ${(item.harvestedQty > 0
                  ? [['em_colheita', STATUS.em_colheita], ['colhido', STATUS.colhido]]
                  : [['planejado', STATUS.planejado]]
                )
                  .map(([value, label]) => option(value, label, item.status))
                  .join('')}
              </select>
            </label>`
          : ''
      }
      <label>Observações<textarea name="notes" maxlength="500" rows="3">${escapeHtml(item?.notes || '')}</textarea></label>
      ${actions(item ? removeButton() : '')}
    </form>`;
}

export function harvestFormHtml(item, catalog, plantings) {
  const selected = item?.plantingId || '';
  const choices = plantingChoices(plantings, selected, 'harvest');
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item?.id ? 'Editar colheita' : 'Nova colheita'}</h2>
        <p class="muted">A quantidade entra no estoque do talhão no Odoo. Várias colheitas parciais podem ser lançadas.</p>
      </div>
    </header>
    <form id="agro-form" class="agro-form" data-kind="colheita">
      <label>Plantio
        <select name="plantingId" required ${item?.id ? 'disabled' : ''}>
          ${option('', 'Selecione', selected)}
          ${choices.map((planting) => option(planting.id, plantingLabel(planting), selected)).join('')}
        </select>
      </label>
      ${item?.id ? `<input type="hidden" name="plantingId" value="${escapeHtml(item.plantingId)}">` : ''}
      ${!choices.length ? '<p class="muted">Não há plantio aberto. Registre um plantio antes da colheita.</p>' : ''}
      <div class="grid-2">
        <label>Data da colheita<input name="harvestedOn" type="date" required value="${escapeHtml(item?.harvestedOn || '')}"></label>
        <label>Quantidade<input name="quantity" inputmode="decimal" required value="${escapeHtml(item?.quantity ?? '')}"></label>
      </div>
      <label>Observações<textarea name="notes" maxlength="500" rows="3">${escapeHtml(item?.notes || '')}</textarea></label>
      <label class="agro-check"><input name="close" type="checkbox" ${item?.plantingStatus === 'colhido' ? 'checked' : ''}> Encerrar a colheita deste plantio</label>
      ${actions(item?.id ? removeButton() : '')}
    </form>`;
}

export function costFormHtml(item, catalog) {
  const plots = (catalog?.properties || []).flatMap((property) =>
    (property.plots || []).map((plot) => ({
      id: plot.id,
      label: `${property.name} · ${plot.label || plot.name}`,
    })),
  );
  const selected = item?.plotId || '';
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item?.id ? 'Editar custo' : 'Novo custo'}</h2>
        <p class="muted">Custo lançado na área (talhão). O valor unitário é opcional e alimenta o dashboard.</p>
      </div>
    </header>
    <form id="agro-form" class="agro-form" data-kind="custos">
      ${
        plots.length
          ? ''
          : '<p class="muted">Cadastre propriedade e talhão em <a href="#/agro/configuracoes">Configurações</a> antes de lançar custos.</p>'
      }
      <div class="grid-2">
        <label>Data
          <input name="costOn" type="date" required value="${escapeHtml(item?.costOn || '')}">
        </label>
        <label>Área (talhão)
          <select name="plotId" required>
            ${option('', 'Selecione', selected)}
            ${plots.map((plot) => option(plot.id, plot.label, selected)).join('')}
          </select>
        </label>
      </div>
      <div class="grid-2">
        <label>Nome
          <input name="name" maxlength="150" required placeholder="ex.: adubo, veneno" value="${escapeHtml(item?.name || '')}">
        </label>
        <label>Quantidade
          <input name="quantity" inputmode="decimal" required value="${escapeHtml(item?.quantity ?? '')}">
        </label>
      </div>
      <div class="grid-2">
        <label>Valor unitário (R$)
          <input name="unitPrice" inputmode="decimal" value="${escapeHtml(item?.unitPrice ?? '')}">
        </label>
        <label>Valor total
          <input data-total readonly value="${escapeHtml(moneyReadonly(item?.totalValue))}">
        </label>
      </div>
      <label>Observações
        <input name="notes" maxlength="500" value="${escapeHtml(item?.notes || '')}">
      </label>
      ${actions(item?.id ? removeButton() : '')}
    </form>`;
}

export function deliveryFormHtml(item, catalog, plantings) {
  const buyers = catalog?.buyers || [];
  const selectedPlanting = item?.plantingId || '';
  const selectedBuyer = item?.partnerId || (item?.partnerName ? '__custom__' : '');
  const choices = plantingChoices(plantings, selectedPlanting, 'delivery');
  return `
    <header class="forms-editor-head">
      <div>
        <h2 id="agro-editor-title">${item?.id ? 'Editar entrega' : 'Nova entrega'}</h2>
        <p class="muted">Salva a entrega localmente. Agrupe na grid para gerar o pedido no Odoo. Locais vêm de Configurações.</p>
      </div>
    </header>
    <form id="agro-form" class="agro-form" data-kind="entrega">
      <div class="grid-2">
        <label>Plantio
          <select name="plantingId" required ${item?.id || item?.odooOrderId ? 'disabled' : ''}>
            ${option('', 'Selecione', selectedPlanting)}
            ${choices
              .map((planting) => {
                const remaining = Number(planting.harvestedQty || 0) - Number(planting.deliveredQty || 0);
                const suffix = ` · saldo ${remaining.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${planting.unit || ''}`.trim();
                return option(planting.id, `${plantingLabel(planting)}${suffix}`, selectedPlanting);
              })
              .join('')}
          </select>
        </label>
        <label>Local de entrega
          <select name="partnerId" required ${item?.odooOrderId ? 'disabled' : ''}>
            ${option('', 'Selecione', selectedBuyer)}
            ${item?.partnerId && !buyers.some((buyer) => buyer.id === item.partnerId) ? option(item.partnerId, item.partnerName, selectedBuyer) : ''}
            ${buyers.map((buyer) => option(buyer.id, buyer.name, selectedBuyer)).join('')}
          </select>
        </label>
      </div>
      ${item?.id ? `<input type="hidden" name="plantingId" value="${escapeHtml(item.plantingId)}">` : ''}
      ${item?.odooOrderId ? `<input type="hidden" name="partnerId" value="${escapeHtml(item.partnerId || '')}">` : ''}
      ${!choices.length ? '<p class="muted">Não há saldo colhido para entregar. Registre a colheita antes.</p>' : ''}
      ${
        buyers.length
          ? ''
          : '<p class="muted">Cadastre os locais de entrega em <a href="#/agro/configuracoes">Configurações</a>.</p>'
      }
      <div data-custom-buyer hidden>
        <label>Nome do local<input name="partnerName" maxlength="150" value=""></label>
      </div>
      <div class="grid-2">
        <label>Data da entrega<input name="deliveredOn" type="date" required value="${escapeHtml(item?.deliveredOn || '')}" ${item?.odooOrderId ? 'readonly' : ''}></label>
        <label>Quantidade<input name="quantity" inputmode="decimal" required value="${escapeHtml(item?.quantity ?? '')}" ${item?.odooOrderId ? 'readonly' : ''}></label>
      </div>
      <div class="grid-2">
        <label>Valor unitário (R$)<input name="unitPrice" inputmode="decimal" value="${escapeHtml(item?.unitPrice ?? '')}" ${item?.odooOrderId ? 'readonly' : ''}></label>
        <label>Valor total<input data-total readonly value="${escapeHtml(item?.totalValue ?? '')}"></label>
      </div>
      <div class="grid-2">
        <label>Documento (NF / romaneio)
          <input name="document" maxlength="150" placeholder="Opcional" value="${escapeHtml(item?.document || '')}" ${item?.odooOrderId ? 'readonly' : ''}>
        </label>
        <label>Pedido Odoo
          <input readonly value="${escapeHtml(item?.odooOrderRef || (item?.odooOrderId ? `#${item.odooOrderId}` : 'Pendente'))}">
        </label>
      </div>
      <label>Observações<input name="notes" maxlength="500" value="${escapeHtml(item?.notes || '')}" ${item?.odooOrderId ? 'readonly' : ''}></label>
      ${item?.odooOrderId ? '<p class="muted">Entrega já vinculada a um pedido Odoo. Exclua pelo estorno no Odoo se precisar refazer.</p>' : ''}
      ${actions(item?.id && !item?.odooOrderId ? removeButton() : '')}
    </form>`;
}

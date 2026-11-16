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
  const target = form.querySelector('[data-total]');
  if (!target) return;
  const quantity = looseNumber(form.quantity?.value);
  const price = looseNumber(form.unitPrice?.value);
  target.value =
    quantity != null && price != null
      ? (Math.round(quantity * price * 100) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : '';
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
      ...plots.map((item) => option(item.id, item.name, current)),
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
        <p class="muted">Produtor, propriedade e talhão vêm de <a href="#/agro/configuracoes">Configurações</a>. A estimativa da safra fica neste plantio.</p>
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
      <div class="grid-2">
        <label>Produto
          <select name="productId" required>
            ${option('', 'Selecione', selectedProduct)}
            ${!knownProduct && item?.productId ? option(item.productId, item.productName, selectedProduct) : ''}
            ${products
              .map((product) => option(product.id, product.uom ? `${product.name} · ${product.uom}` : product.name, selectedProduct, `data-uom="${escapeHtml(product.uom)}"`))
              .join('')}
            ${option('__custom__', 'Outra cultura', selectedProduct)}
          </select>
        </label>
        <label>Área planejada (ha)<input name="areaPlanned" inputmode="decimal" required value="${escapeHtml(item?.areaPlanned ?? '')}"></label>
      </div>
      <div class="grid-2" data-custom-product hidden>
        <label>Nome da cultura<input name="productName" maxlength="150" value="${escapeHtml(item && !item.productId ? item.productName : '')}"></label>
        <label>Unidade<input name="unit" maxlength="20" value="${escapeHtml(item?.unit || '')}" placeholder="kg, sc, t"></label>
      </div>
      <div class="grid-2">
        <label>Data do plantio<input name="plantedOn" type="date" required value="${escapeHtml(item?.plantedOn || '')}"></label>
        <label>Previsão de colheita<input name="forecastOn" type="date" value="${escapeHtml(item?.forecastOn || '')}"></label>
      </div>
      <div class="grid-2">
        <label>Estimativa da safra<input name="forecastQty" inputmode="decimal" value="${escapeHtml(item?.forecastQty ?? '')}" placeholder="Quantidade prevista"></label>
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
            : '<span></span>'
        }
      </div>
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
      label: `${property.name} · ${plot.name}`,
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
        <label>Observações
          <input name="notes" maxlength="500" value="${escapeHtml(item?.notes || '')}">
        </label>
      </div>
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
        <p class="muted">Gera um pedido de venda no Odoo e baixa o estoque do talhão. O preço sugerido vem do produto.</p>
      </div>
    </header>
    <form id="agro-form" class="agro-form" data-kind="entrega">
      <div class="grid-2">
        <label>Plantio
          <select name="plantingId" required ${item?.id ? 'disabled' : ''}>
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
        <label>Comprador
          <select name="partnerId" required>
            ${option('', 'Selecione', selectedBuyer)}
            ${item?.partnerId && !buyers.some((buyer) => buyer.id === item.partnerId) ? option(item.partnerId, item.partnerName, selectedBuyer) : ''}
            ${buyers.map((buyer) => option(buyer.id, buyer.name, selectedBuyer)).join('')}
            ${option('__custom__', 'Outro comprador', selectedBuyer)}
          </select>
        </label>
      </div>
      ${item?.id ? `<input type="hidden" name="plantingId" value="${escapeHtml(item.plantingId)}">` : ''}
      ${!choices.length ? '<p class="muted">Não há saldo colhido para entregar. Registre a colheita antes.</p>' : ''}
      <div data-custom-buyer hidden>
        <label>Nome do comprador<input name="partnerName" maxlength="150" value="${escapeHtml(item && !item.partnerId ? item.partnerName : '')}"></label>
      </div>
      <div class="grid-2">
        <label>Data da entrega<input name="deliveredOn" type="date" required value="${escapeHtml(item?.deliveredOn || '')}"></label>
        <label>Quantidade<input name="quantity" inputmode="decimal" required value="${escapeHtml(item?.quantity ?? '')}"></label>
      </div>
      <div class="grid-2">
        <label>Valor unitário (R$)<input name="unitPrice" inputmode="decimal" value="${escapeHtml(item?.unitPrice ?? '')}"></label>
        <label>Valor total<input data-total readonly value="${escapeHtml(item?.totalValue ?? '')}"></label>
      </div>
      <div class="grid-2">
        <label>Documento<input name="document" maxlength="150" placeholder="NF ou romaneio. Vazio usa o pedido do Odoo" value="${escapeHtml(item?.document || '')}"></label>
        <label>Observações<input name="notes" maxlength="500" value="${escapeHtml(item?.notes || '')}"></label>
      </div>
      ${actions(item?.id ? removeButton() : '')}
    </form>`;
}

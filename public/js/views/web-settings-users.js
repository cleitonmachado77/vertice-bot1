import { api } from '../api.js';
import { escapeHtml, toast } from '../ui.js';

function roleLabel(role) {
  return role === 'adm' ? 'ADM' : 'Gestor Entidade';
}

function companyOptionsHtml(companies, selectedId = '') {
  return (companies || [])
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(item.name)}</option>`,
    )
    .join('');
}

export function renderUsersSection(pack) {
  const items = pack?.items || [];
  const companies = pack?.companies || [];

  return `
    <section class="card stack web-odoo-card users-card" id="users-section">
      <div class="card-head">
        <h2>Usuários</h2>
        <p class="muted">ADM tem acesso total. Gestor Entidade fica restrito à empresa vinculada.</p>
      </div>

      <form class="users-create stack" id="user-form">
        <input type="hidden" name="id" id="user-id" value="" />
        <p class="users-form-title" id="user-form-title">Novo usuário</p>
        <div class="grid-2">
          <div>
            <label>Nome</label>
            <input name="name" id="user-name" required placeholder="Nome completo" />
          </div>
          <div>
            <label>E-mail</label>
            <input name="email" id="user-email" type="email" required placeholder="usuario@empresa.com" />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <label id="user-password-label">Senha inicial</label>
            <input name="password" id="user-password" type="password" minlength="6" placeholder="mín. 6 caracteres" required />
          </div>
          <div>
            <label>Perfil</label>
            <select name="role" id="user-role">
              <option value="user">Gestor Entidade</option>
              <option value="adm">ADM</option>
            </select>
          </div>
        </div>
        <div id="user-company-wrap">
          <label>Empresa</label>
          <select name="companyOdooId" id="user-company">
            <option value="">Selecione a empresa</option>
            ${companyOptionsHtml(companies)}
          </select>
        </div>
        <div class="row" id="user-form-actions">
          <button class="btn" type="submit" id="user-submit">Criar usuário</button>
          <button class="btn-ghost" type="button" id="user-cancel" hidden>Cancelar</button>
        </div>
      </form>

      <div class="users-table-wrap">
        <table class="users-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Perfil</th>
              <th>Empresa</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="users-tbody">
            ${
              items.length
                ? items
                    .map((item) => {
                      const company =
                        companies.find((c) => c.id === item.companyOdooId)?.name ||
                        (item.companyOdooId ? `#${item.companyOdooId}` : '—');
                      return `
              <tr data-user-id="${escapeHtml(item.id)}">
                <td>${escapeHtml(item.name)}</td>
                <td>${escapeHtml(item.email)}</td>
                <td><span class="role-pill role-pill--${escapeHtml(item.role)}">${roleLabel(item.role)}</span></td>
                <td>${escapeHtml(company)}</td>
                <td>${item.active ? 'Ativo' : 'Inativo'}</td>
                <td class="users-actions">
                  <button class="btn-ghost" type="button" data-edit-user>Editar</button>
                  <button class="btn-ghost" type="button" data-toggle-active>${item.active ? 'Desativar' : 'Ativar'}</button>
                  <button class="btn-danger" type="button" data-delete-user>Remover</button>
                </td>
              </tr>`;
                    })
                    .join('')
                : '<tr><td colspan="6" class="muted">Nenhum usuário cadastrado.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>`;
}

function syncCompanyVisibility(root) {
  const roleSelect = root.querySelector('#user-role');
  const companyWrap = root.querySelector('#user-company-wrap');
  if (!companyWrap) return;
  companyWrap.hidden = roleSelect?.value === 'adm';
}

function setCreateMode(root, companies) {
  const form = root.querySelector('#user-form');
  if (!form) return;
  form.reset();
  root.querySelector('#user-id').value = '';
  root.querySelector('#user-form-title').textContent = 'Novo usuário';
  root.querySelector('#user-password-label').textContent = 'Senha inicial';
  const password = root.querySelector('#user-password');
  password.required = true;
  password.placeholder = 'mín. 6 caracteres';
  root.querySelector('#user-submit').textContent = 'Criar usuário';
  root.querySelector('#user-cancel').hidden = true;
  root.querySelector('#user-company').innerHTML =
    `<option value="">Selecione a empresa</option>${companyOptionsHtml(companies)}`;
  syncCompanyVisibility(root);
}

function setEditMode(root, user, companies) {
  root.querySelector('#user-id').value = user.id;
  root.querySelector('#user-name').value = user.name || '';
  root.querySelector('#user-email').value = user.email || '';
  root.querySelector('#user-role').value = user.role === 'adm' ? 'adm' : 'user';
  const password = root.querySelector('#user-password');
  password.value = '';
  password.required = false;
  password.placeholder = 'deixe em branco para manter';
  root.querySelector('#user-password-label').textContent = 'Nova senha (opcional)';
  root.querySelector('#user-form-title').textContent = `Editar · ${user.name || user.email}`;
  root.querySelector('#user-submit').textContent = 'Salvar alterações';
  root.querySelector('#user-cancel').hidden = false;
  root.querySelector('#user-company').innerHTML =
    `<option value="">Selecione a empresa</option>${companyOptionsHtml(companies, user.companyOdooId || '')}`;
  syncCompanyVisibility(root);
  root.querySelector('#user-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function bindUsersSection(root, reload, pack = null) {
  const companies = pack?.companies || [];
  const users = pack?.items || [];

  root.querySelector('#user-role')?.addEventListener('change', () => syncCompanyVisibility(root));
  syncCompanyVisibility(root);

  root.querySelector('#user-cancel')?.addEventListener('click', () => setCreateMode(root, companies));

  root.querySelector('#user-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get('id') || '').trim();
    const role = String(form.get('role') || 'user');
    const password = String(form.get('password') || '');
    const body = {
      name: String(form.get('name') || ''),
      email: String(form.get('email') || ''),
      role,
      companyOdooId: role === 'adm' ? '' : String(form.get('companyOdooId') || ''),
    };
    if (password) body.password = password;

    try {
      if (id) {
        await api(`/api/users/${encodeURIComponent(id)}`, { method: 'PUT', body });
        toast('Usuário atualizado');
      } else {
        if (!password) {
          toast('Informe a senha inicial');
          return;
        }
        await api('/api/users', { method: 'POST', body: { ...body, password } });
        toast('Usuário criado');
      }
      await reload();
    } catch (error) {
      toast(error.message);
    }
  });

  root.querySelector('#users-tbody')?.addEventListener('click', async (event) => {
    const row = event.target.closest('tr[data-user-id]');
    if (!row) return;
    const id = row.getAttribute('data-user-id');
    if (!id) return;
    const user = users.find((item) => item.id === id);

    if (event.target.closest('[data-edit-user]')) {
      if (!user) {
        toast('Usuário não encontrado');
        return;
      }
      setEditMode(root, user, companies);
      return;
    }

    if (event.target.closest('[data-delete-user]')) {
      if (!confirm('Remover este usuário?')) return;
      try {
        await api(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
        toast('Usuário removido');
        await reload();
      } catch (error) {
        toast(error.message);
      }
      return;
    }

    if (event.target.closest('[data-toggle-active]')) {
      const activeLabel = event.target.closest('[data-toggle-active]')?.textContent || '';
      const active = !/Desativar/i.test(activeLabel);
      try {
        await api(`/api/users/${encodeURIComponent(id)}`, { method: 'PUT', body: { active } });
        toast(active ? 'Usuário ativado' : 'Usuário desativado');
        await reload();
      } catch (error) {
        toast(error.message);
      }
    }
  });
}

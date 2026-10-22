import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import { many, one, run } from './db.js';
import { normalizeWhatsappPhone } from './phone.js';

export type UserRole = 'adm' | 'user';

export type PanelUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  company_odoo_id: string;
  whatsapp_phone: string;
  active: number;
  created_at: string;
  updated_at: string;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  companyOdooId: string;
  whatsappPhone: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateUserInput = {
  email: string;
  name: string;
  password: string;
  role: UserRole;
  companyOdooId?: string;
  whatsappPhone?: string;
};

export type UpdateUserInput = {
  email?: string;
  name?: string;
  password?: string;
  role?: UserRole;
  companyOdooId?: string;
  whatsappPhone?: string;
  active?: boolean;
};

function normalizeEmail(email: string): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function normalizeRole(role: unknown): UserRole {
  return role === 'user' ? 'user' : 'adm';
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const digest = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (digest.length !== expected.length) return false;
  return timingSafeEqual(digest, expected);
}

export function toPublicUser(row: PanelUser): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: normalizeRole(row.role),
    companyOdooId: row.company_odoo_id || '',
    whatsappPhone: row.whatsapp_phone || '',
    active: Number(row.active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUserPhone(raw: string | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return normalizeWhatsappPhone(value);
}

export function isAdm(user: Pick<PublicUser, 'role'> | null | undefined): boolean {
  return user?.role === 'adm';
}

async function getPasswordHash(id: string): Promise<string> {
  const row = await one<{ password_hash: string }>(`SELECT password_hash FROM panel_users WHERE id = $1`, [id]);
  return row?.password_hash || '';
}

export async function countUsers(): Promise<number> {
  const row = await one<{ total: number }>(`SELECT COUNT(*)::int AS total FROM panel_users`);
  return row?.total || 0;
}

export async function listUsers(): Promise<PublicUser[]> {
  const rows = await many<PanelUser>(
    `SELECT id, email, name, role, company_odoo_id, COALESCE(whatsapp_phone, '') AS whatsapp_phone,
            active, created_at, updated_at
     FROM panel_users
     ORDER BY role ASC, name ASC, email ASC`,
  );
  return rows.map(toPublicUser);
}

export async function getUserById(id: string): Promise<PanelUser | undefined> {
  return one<PanelUser>(
    `SELECT id, email, name, role, company_odoo_id, COALESCE(whatsapp_phone, '') AS whatsapp_phone,
            active, created_at, updated_at
     FROM panel_users WHERE id = $1`,
    [id],
  );
}

export async function getUserByEmail(email: string): Promise<(PanelUser & { password_hash: string }) | undefined> {
  return one<PanelUser & { password_hash: string }>(
    `SELECT id, email, name, role, company_odoo_id, COALESCE(whatsapp_phone, '') AS whatsapp_phone,
            active, created_at, updated_at, password_hash
     FROM panel_users WHERE email = $1`,
    [normalizeEmail(email)],
  );
}

export async function authenticateUser(email: string, password: string): Promise<PublicUser | null> {
  const row = await getUserByEmail(email);
  if (!row || Number(row.active) !== 1) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return toPublicUser(row);
}

function assertUserShape(input: { email: string; name: string; role: UserRole; companyOdooId?: string; password?: string }) {
  const email = normalizeEmail(input.email);
  const name = String(input.name || '').trim();
  if (!email || !email.includes('@')) throw new Error('Informe um e-mail válido');
  if (!name) throw new Error('Informe o nome do usuário');
  if (input.role === 'user' && !String(input.companyOdooId || '').trim()) {
    throw new Error('Gestores Entidade precisam de uma empresa vinculada');
  }
  if (input.password !== undefined) {
    if (String(input.password).length < 6) throw new Error('A senha precisa ter ao menos 6 caracteres');
  }
  return {
    email,
    name,
    role: input.role,
    companyOdooId: input.role === 'adm' ? '' : String(input.companyOdooId || '').trim(),
  };
}

export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const shape = assertUserShape({ ...input, password: input.password });
  if (!input.password) throw new Error('Informe a senha');
  const existing = await getUserByEmail(shape.email);
  if (existing) throw new Error('Já existe um usuário com este e-mail');
  const now = new Date().toISOString();
  const id = randomUUID();
  const whatsappPhone = normalizeUserPhone(input.whatsappPhone);
  await run(
    `INSERT INTO panel_users(id, email, name, password_hash, role, company_odoo_id, whatsapp_phone, active, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
    [id, shape.email, shape.name, hashPassword(input.password), shape.role, shape.companyOdooId, whatsappPhone, now],
  );
  const row = await getUserById(id);
  if (!row) throw new Error('Falha ao criar usuário');
  return toPublicUser(row);
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<PublicUser> {
  const current = await getUserById(id);
  if (!current) throw new Error('Usuário não encontrado');

  const nextRole = input.role ? normalizeRole(input.role) : normalizeRole(current.role);
  const shape = assertUserShape({
    email: input.email ?? current.email,
    name: input.name ?? current.name,
    role: nextRole,
    companyOdooId: input.companyOdooId ?? current.company_odoo_id,
    password: input.password,
  });

  if (shape.email !== current.email) {
    const clash = await getUserByEmail(shape.email);
    if (clash && clash.id !== id) throw new Error('Já existe um usuário com este e-mail');
  }

  const active = input.active === undefined ? Number(current.active) === 1 : Boolean(input.active);
  if (!active && current.role === 'adm') {
    const admins = await one<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM panel_users WHERE role = 'adm' AND active = 1 AND id <> $1`,
      [id],
    );
    if (!admins?.total) throw new Error('Mantenha ao menos um administrador ativo');
  }

  const passwordHash = input.password ? hashPassword(input.password) : await getPasswordHash(id);
  const whatsappPhone =
    input.whatsappPhone !== undefined
      ? normalizeUserPhone(input.whatsappPhone)
      : current.whatsapp_phone || '';
  const now = new Date().toISOString();
  await run(
    `UPDATE panel_users
     SET email = $2, name = $3, password_hash = $4, role = $5, company_odoo_id = $6,
         whatsapp_phone = $7, active = $8, updated_at = $9
     WHERE id = $1`,
    [
      id,
      shape.email,
      shape.name,
      passwordHash,
      shape.role,
      shape.companyOdooId,
      whatsappPhone,
      active ? 1 : 0,
      now,
    ],
  );
  const row = await getUserById(id);
  if (!row) throw new Error('Usuário não encontrado');
  return toPublicUser(row);
}

export async function deleteUser(id: string, actorId: string): Promise<void> {
  if (id === actorId) throw new Error('Você não pode remover a própria conta');
  const current = await getUserById(id);
  if (!current) throw new Error('Usuário não encontrado');
  if (current.role === 'adm') {
    const admins = await one<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM panel_users WHERE role = 'adm' AND active = 1 AND id <> $1`,
      [id],
    );
    if (!admins?.total) throw new Error('Mantenha ao menos um administrador');
  }
  await run(`DELETE FROM panel_users WHERE id = $1`, [id]);
}

/** Garante o primeiro ADM a partir de PANEL_PASSWORD / PANEL_ADMIN_EMAIL. */
export async function ensureBootstrapAdmin(): Promise<void> {
  if ((await countUsers()) > 0) return;
  const password = env('PANEL_PASSWORD', '');
  if (!password) {
    console.warn('auth: nenhum usuário e PANEL_PASSWORD vazio — crie um ADM depois');
    return;
  }
  const email = normalizeEmail(env('PANEL_ADMIN_EMAIL', 'admin@vertice.local'));
  const name = env('PANEL_ADMIN_NAME', 'Administrador');
  await createUser({ email, name, password, role: 'adm' });
  console.log(`auth: ADM inicial criado (${email})`);
}

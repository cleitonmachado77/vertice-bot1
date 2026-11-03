import {
  mountHubDashboard,
  renderDashboardShell,
  renderDashboardStats,
  renderPeriodPicker,
  stopHubDashboard,
} from './hub-dashboard.js';

export { stopHubDashboard };

export async function renderHub(root, me = null) {
  stopHubDashboard();
  const now = new Date();

  root.innerHTML = `
    <div class="view-pane hub-view">
      <div class="page-head hub-head">
        ${renderPeriodPicker({ month: now.getMonth() + 1, year: now.getFullYear() })}
      </div>

      ${renderDashboardStats()}

      <h2 class="section-title">Indicadores do período</h2>
      ${renderDashboardShell()}
    </div>`;

  await mountHubDashboard(root);
}

const adminKey = document.body.dataset.adminKey ?? '';
const list = document.getElementById('admin-list');
const countEl = document.getElementById('admin-count');

list.addEventListener('click', async (event) => {
  const button = event.target.closest('.delete');
  if (!button) return;

  const id = button.dataset.id;
  const row = button.closest('.row');
  if (!id || !row) return;

  button.disabled = true;
  button.textContent = 'Deleting…';

  try {
    const response = await fetch(`/api/answers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': adminKey, accept: 'application/json' },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);

    row.classList.add('is-gone');
    row.remove();
    if (typeof data.count === 'number') countEl.textContent = String(data.count);
  } catch (error) {
    console.error('[admin] delete failed', error);
    button.disabled = false;
    button.textContent = 'Retry delete';
  }
});

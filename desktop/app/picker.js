// Lists what can be shared; names come from other apps' windows, so they
// are text, never markup.
const { ru, list } = await window.picker.list();
document.getElementById('title').textContent = ru ? 'Что показать' : 'What to share';
const cancel = document.getElementById('cancel');
cancel.textContent = ru ? 'Отмена' : 'Cancel';
cancel.onclick = () => window.picker.choose(null);
document.addEventListener('keydown', (e) => e.key === 'Escape' && window.picker.choose(null));
const ul = document.getElementById('list');
for (const s of list) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'source';
  const img = document.createElement('img');
  img.src = s.thumb;
  img.alt = '';
  const name = document.createElement('span');
  name.textContent = s.name;
  b.append(img, name);
  b.onclick = () => window.picker.choose(s.id);
  li.append(b);
  ul.append(li);
}
ul.querySelector('button')?.focus();

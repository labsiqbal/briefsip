const form = document.querySelector('form');
const input = document.querySelector('input');
const error = document.querySelector('#error');
const button = document.querySelector('button');
error.textContent = new URLSearchParams(location.search).get('error') ?? '';
window.minarbotDesktop.appVersion().then((version) => { document.querySelector('#version').textContent = `Minarbot ${version}`; });
form.addEventListener('submit', (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Connecting...';
  window.location.assign(`minarbot-connect:${encodeURIComponent(input.value.trim())}`);
});

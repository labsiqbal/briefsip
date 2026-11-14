const form = document.querySelector('form');
const input = document.querySelector('input');
const error = document.querySelector('#error');
const button = document.querySelector('button');
error.textContent = new URLSearchParams(location.search).get('error') ?? '';
window.briefsipDesktop.appVersion().then((version) => { document.querySelector('#version').textContent = `Briefsip ${version}`; });
form.addEventListener('submit', (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Connecting...';
  window.location.assign(`briefsip-connect:${encodeURIComponent(input.value.trim())}`);
});

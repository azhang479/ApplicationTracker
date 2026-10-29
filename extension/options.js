import { backendUrl } from './shared.js';

const backend = document.getElementById('backend');
const key = document.getElementById('key');
const message = document.getElementById('message');
async function load() {
  try {
    const data = await chrome.storage.sync.get(['backendUrl', 'apiKey']);
    backend.value = data.backendUrl || '';
    key.value = data.apiKey || '';
  } catch {
    message.textContent = 'Your settings could not be loaded. Please reopen this page.';
  }
}
void load();
document.getElementById('options').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await chrome.storage.sync.set({
      backendUrl: backendUrl(backend.value.trim()),
      apiKey: key.value.trim(),
    });
    message.className = 'success';
    message.textContent = 'Settings saved. You’re ready to track your next opportunity.';
  } catch (error) {
    message.className = 'error';
    message.textContent = error.message;
  }
});

import { settings, salary } from './shared.js';

const track = document.getElementById('track');
const message = document.getElementById('message');
function showError(error) {
  message.className = 'error';
  message.textContent = error.message || 'Something went wrong. Please try again.';
}
track.addEventListener('click', async () => {
  track.disabled = true;
  document.getElementById('result').hidden = true;
  message.className = '';
  message.textContent = 'Extracting… (can take ~10s)';
  try {
    const config = await settings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || ''))
      throw new Error('Open a job posting on a regular web page first.');
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        pageTitle: document.title,
        text: document.body.innerText.slice(0, 40000),
      }),
    });
    if (!injection?.result)
      throw new Error('This page could not be read. Try another job posting.');
    const response = await fetch(config.url + '/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify(injection.result),
      signal: AbortSignal.timeout(90000),
    });
    if (response.status === 401) throw new Error('Your API key was not accepted. Check Settings.');
    if (!response.ok) throw new Error('The job could not be saved. Please try again in a moment.');
    const job = await response.json();
    message.textContent = '';
    document.getElementById('result-label').textContent = job.duplicate
      ? '✓ Already tracked'
      : '✓ Added to your applications';
    document.getElementById('company').textContent = job.company;
    document.getElementById('title').textContent = job.title;
    document.getElementById('salary').textContent = salary(job);
    document.getElementById('result').hidden = false;
  } catch (error) {
    showError(error);
  } finally {
    track.disabled = false;
  }
});
document.getElementById('dashboard').addEventListener('click', async () => {
  try {
    const config = await settings();
    await chrome.tabs.create({ url: config.url });
  } catch (error) {
    showError(error);
  }
});
document.getElementById('settings').addEventListener('click', (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

import { settings, salary, outreachPrompt } from './shared.js';

const JOB_TEXT_LIMIT = 20_000;

const track = document.getElementById('track');
const tailor = document.getElementById('tailor');
const outreach = document.getElementById('outreach');
const referral = document.getElementById('referral');
const captureButtons = [track, tailor, outreach, referral];
const message = document.getElementById('message');
const outreachPreview = document.getElementById('outreach-preview');

function showError(error) {
  message.className = 'error';
  message.textContent = error.message || 'Something went wrong. Please try again.';
}
async function copyOutreachPrompt(prompt) {
  try {
    await navigator.clipboard.writeText(prompt);
    message.textContent = 'Outreach prompt copied. Paste it into ChatGPT.';
  } catch {
    message.textContent = 'Copy the selected outreach prompt below.';
    outreachPreview.value = prompt;
    outreachPreview.hidden = false;
    outreachPreview.focus();
    outreachPreview.select();
  }
}
async function capture(action = 'track') {
  captureButtons.forEach((button) => (button.disabled = true));
  document.getElementById('result').hidden = true;
  outreachPreview.hidden = true;
  outreachPreview.value = '';
  message.className = '';
  message.textContent = 'Extracting… (can take ~10s)';
  try {
    const config = await settings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || ''))
      throw new Error('Open a job posting on a regular web page first.');
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [JOB_TEXT_LIMIT],
      func: (limit) => ({
        url: location.href,
        pageTitle: document.title,
        text: document.body.innerText.slice(0, limit),
      }),
    });
    if (!injection?.result)
      throw new Error('This page could not be read. Try another job posting.');
    let response;
    try {
      response = await fetch(config.url + '/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
        body: JSON.stringify(
          action === 'referral' ? { ...injection.result, intent: 'referral' } : injection.result,
        ),
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      throw new Error("Can't reach the server. Check the backend URL in Settings.");
    }
    if (response.status === 401) throw new Error("API key doesn't match. Check Settings.");
    if (response.status === 400) throw new Error("Couldn't read this job page.");
    if (response.status >= 500) throw new Error('Server error. Try again.');
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
    if (action === 'tailor') {
      await chrome.tabs.create({ url: config.url + '/tailor/' + encodeURIComponent(job.id) });
    } else if (action === 'referral') {
      await chrome.tabs.create({
        url: config.url + '/referrals/' + encodeURIComponent(job.id) + '?find=1',
      });
    } else if (action === 'outreach') {
      await copyOutreachPrompt(outreachPrompt(job, injection.result.url));
    }
  } catch (error) {
    showError(error);
  } finally {
    captureButtons.forEach((button) => (button.disabled = false));
  }
}
track.addEventListener('click', () => capture());
tailor.addEventListener('click', () => capture('tailor'));
outreach.addEventListener('click', () => capture('outreach'));
referral.addEventListener('click', () => capture('referral'));
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

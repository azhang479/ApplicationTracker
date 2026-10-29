export function backendUrl(value) {
  const url = new URL(value);
  const cloudRun = url.protocol === 'https:' && url.hostname.endsWith('.run.app');
  const local = url.origin === 'http://localhost:8080';
  if (
    (!cloudRun && !local) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use your https://…run.app address or http://localhost:8080, without a path.');
  }
  return url.origin;
}
export async function settings() {
  const data = await chrome.storage.sync.get(['backendUrl', 'apiKey']);
  if (!data.backendUrl || !data.apiKey)
    throw new Error('First, add your dashboard address and API key in Settings.');
  return { url: backendUrl(data.backendUrl), apiKey: data.apiKey };
}
export function salary(job) {
  const money = (n) => {
    const prefix = job.salaryCurrency === 'USD' ? '$' : job.salaryCurrency + ' ';
    return (
      prefix +
      (n >= 1000 ? (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'k' : n)
    );
  };
  let text = 'Salary not listed';
  if (job.salaryMin != null && job.salaryMax != null)
    text = money(job.salaryMin) + '–' + money(job.salaryMax);
  else if (job.salaryMin != null) text = 'From ' + money(job.salaryMin);
  else if (job.salaryMax != null) text = 'Up to ' + money(job.salaryMax);
  if (job.salaryMin != null || job.salaryMax != null)
    text += job.salaryPeriod === 'hour' ? '/hr' : '/yr';
  if (job.salaryIsEstimated) text += ' · est.';
  return text;
}

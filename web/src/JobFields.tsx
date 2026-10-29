import type { Job } from './types';

export const blankJob: Job = {
  company: '',
  title: '',
  jobId: '',
  url: '',
  location: '',
  workMode: 'unknown',
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: 'USD',
  salaryPeriod: 'year',
  salaryIsEstimated: false,
  jobSummary: '',
  keyRequirements: [],
};
export function JobFields({ value, onChange }: { value: Job; onChange: (value: Job) => void }) {
  function set<K extends keyof Job>(key: K, next: Job[K]) {
    onChange({ ...value, [key]: next });
  }
  return (
    <div className="grid grid-cols-2 gap-4">
      <label className="col-span-2">
        Company
        <input required value={value.company} onChange={(e) => set('company', e.target.value)} />
      </label>
      <label className="col-span-2">
        Job title
        <input required value={value.title} onChange={(e) => set('title', e.target.value)} />
      </label>
      <label>
        Job reference number
        <input value={value.jobId} onChange={(e) => set('jobId', e.target.value)} />
      </label>
      <label>
        Location
        <input value={value.location} onChange={(e) => set('location', e.target.value)} />
      </label>
      <label className="col-span-2">
        Job posting link
        <input required type="url" value={value.url} onChange={(e) => set('url', e.target.value)} />
      </label>
      <label className="col-span-2">
        Work arrangement
        <select
          value={value.workMode}
          onChange={(e) => set('workMode', e.target.value as Job['workMode'])}
        >
          <option value="unknown">Not specified</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">On-site</option>
        </select>
      </label>
      <label>
        Minimum salary
        <input
          type="number"
          min="0"
          step="any"
          value={value.salaryMin ?? ''}
          onChange={(e) => set('salaryMin', e.target.value === '' ? null : Number(e.target.value))}
        />
      </label>
      <label>
        Maximum salary
        <input
          type="number"
          min="0"
          step="any"
          value={value.salaryMax ?? ''}
          onChange={(e) => set('salaryMax', e.target.value === '' ? null : Number(e.target.value))}
        />
      </label>
      <label>
        Currency
        <input
          required
          value={value.salaryCurrency}
          onChange={(e) => set('salaryCurrency', e.target.value.toUpperCase())}
        />
      </label>
      <label>
        Salary period
        <select
          value={value.salaryPeriod}
          onChange={(e) => set('salaryPeriod', e.target.value as Job['salaryPeriod'])}
        >
          <option value="year">Per year</option>
          <option value="hour">Per hour</option>
        </select>
      </label>
      <label className="col-span-2 flex items-center gap-2">
        <input
          className="!w-4 !m-0"
          type="checkbox"
          checked={value.salaryIsEstimated}
          onChange={(e) => set('salaryIsEstimated', e.target.checked)}
        />
        This salary is an estimate
      </label>
      <label className="col-span-2">
        Job summary
        <textarea
          rows={3}
          value={value.jobSummary}
          onChange={(e) => set('jobSummary', e.target.value)}
        />
      </label>
      <label className="col-span-2">
        Key requirements <span className="text-slate-400 font-normal">(one per line)</span>
        <textarea
          rows={3}
          value={value.keyRequirements.join('\n')}
          onChange={(e) => set('keyRequirements', e.target.value.split('\n'))}
        />
      </label>
    </div>
  );
}

import { roleTypeLabels, type RoleType } from './types';

export type RoleTypeSelection = RoleType | 'all';
const labels = { all: 'All roles', ...roleTypeLabels };

export function RoleTypeFilter({
  value,
  onChange,
}: {
  value: RoleTypeSelection;
  onChange: (value: RoleTypeSelection) => void;
}) {
  return (
    <div
      className="application-filters flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Role type"
    >
      <span className="text-xs font-medium text-slate-500 mr-1">Role type</span>
      {(Object.keys(labels) as RoleTypeSelection[]).map((type) => (
        <button
          key={type}
          type="button"
          className={'chip ' + (value === type ? 'chip-active' : '')}
          aria-pressed={value === type}
          onClick={() => onChange(type)}
        >
          {labels[type]}
        </button>
      ))}
    </div>
  );
}
